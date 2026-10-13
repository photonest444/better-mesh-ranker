//! Мост «JSON → JSON»: единый диспетчер методов для CLI и для Node.
//!
//! Протокол (одна строка — один запрос, ответ — одна строка):
//!
//! ```text
//! → {"id":1,"method":"rank.build","params":{"members":[…],"names":{…},"meId":"uuid"}}
//! ← {"id":1,"ok":true,"result":{"rows":[…],"summary":{…}}}
//! ← {"id":1,"ok":false,"error":{"code":"network","message":"…"}}
//! ```
//!
//! Тот же `Session` использует нативный CLI (`mesh-rank rank`, `mesh-rank insights`),
//! поэтому поведение терминала и приложения гарантированно совпадает.

use std::path::PathBuf;

use crate::bench;
use crate::cache::{HistoryStore, NameCache, TokenFile};
use crate::client::{ClientOptions, MeshClient, RankBoardOptions};
use crate::error::{MeshError, MeshResult};
use crate::format::{self, Column, ColumnFormat};
use crate::insights::{self, Snapshot};
use crate::json::Json;
use crate::marks;
use crate::model::Mark;
use crate::normalize;
use crate::rank;
use crate::stats;
use crate::token;
use crate::util;

/// Все методы, которые понимает мост (используется в `hello` и в диагностике).
pub const METHODS: [&str; 34] = [
    "hello",
    "state",
    "signIn",
    "signOut",
    "refreshToken",
    "selectStudent",
    "profile",
    "subjects",
    "subjectMarks",
    "rank",
    "marks",
    "homeworks",
    "schedule",
    "names",
    "ping",
    "token.describe",
    "token.extract",
    "stats.describe",
    "rank.build",
    "marks.summarize",
    "homeworks.normalize",
    "schedule.normalize",
    "homeworks.deadlines",
    "insights.history",
    "insights.forecast",
    "insights.whatIf",
    "insights.impact",
    "csv.rank",
    "csv.marks",
    "history.list",
    "history.append",
    "history.clear",
    "cache.stats",
    "bench",
];

/// Настройки сессии моста.
#[derive(Clone, Debug)]
pub struct SessionOptions {
    pub base_url: String,
    pub token: Option<String>,
    pub profile_id: Option<String>,
    pub timeout_ms: u64,
    pub cache_ttl_ms: i64,
    pub demo: bool,
    pub auto_refresh: bool,
    pub history_path: Option<PathBuf>,
    pub name_cache_path: Option<PathBuf>,
}

impl Default for SessionOptions {
    fn default() -> SessionOptions {
        SessionOptions {
            base_url: crate::client::HOST.to_string(),
            token: None,
            profile_id: None,
            timeout_ms: 15_000,
            cache_ttl_ms: 30_000,
            demo: false,
            auto_refresh: true,
            history_path: None,
            name_cache_path: None,
        }
    }
}

impl SessionOptions {
    /// Демо-режим: локальный мок-сервер МЭШ, короткие токены разрешены.
    pub fn demo(mock_base_url: &str) -> SessionOptions {
        SessionOptions {
            base_url: mock_base_url.to_string(),
            token: Some("mock-token-1".to_string()),
            demo: true,
            ..SessionOptions::default()
        }
    }
}

/// Живая сессия: клиент, локальная история и кэши.
pub struct Session {
    pub client: MeshClient,
    pub demo: bool,
    pub history: Option<HistoryStore>,
    pub started_at: i64,
    /// `contingent_guid` активного ученика из файла авторизации (если он был).
    pub active_person_id: Option<String>,
    history_path: Option<PathBuf>,
    name_cache_path: Option<PathBuf>,
}

impl Session {
    pub fn new(options: SessionOptions) -> Session {
        let name_cache = match &options.name_cache_path {
            Some(path) => NameCache::load(path),
            None => NameCache::in_memory(),
        };
        let client = MeshClient::new(ClientOptions {
            base_url: options.base_url.clone(),
            token: options.token.clone(),
            profile_id: options.profile_id.clone(),
            timeout: std::time::Duration::from_millis(options.timeout_ms.max(1_000)),
            auto_refresh: options.auto_refresh,
            cache_ttl_ms: options.cache_ttl_ms,
            name_cache,
        });
        Session {
            client,
            demo: options.demo,
            history: options
                .history_path
                .as_ref()
                .map(|path| HistoryStore::load(path)),
            started_at: util::now_ms(),
            history_path: options.history_path,
            name_cache_path: options.name_cache_path,
            active_person_id: None,
        }
    }

    /// Загружает токен из файла авторизации (совместим с ranker.py и JS-ядром).
    pub fn with_token_file(mut self, path: &std::path::Path) -> Session {
        if let Some(data) = TokenFile::load(path) {
            self.client.token = Some(data.token);
            if !data.profile_id.is_empty() {
                self.client.profile_id = Some(data.profile_id);
            }
            if !data.contingent_guid.is_empty() {
                self.active_person_id = Some(data.contingent_guid);
            }
        }
        self
    }

    fn history(&mut self) -> MeshResult<&mut HistoryStore> {
        if self.history.is_none() {
            let path = self
                .history_path
                .clone()
                .ok_or_else(|| MeshError::new("no-history", "Локальная история не подключена (нет каталога данных)"))?;
            self.history = Some(HistoryStore::load(&path));
        }
        self.history
            .as_mut()
            .ok_or_else(|| MeshError::new("no-history", "Локальная история недоступна"))
    }

    /// Сохраняет кэш имён на диск (если путь задан).
    pub fn flush(&self) {
        if self.name_cache_path.is_some() {
            let _ = self.client.name_cache().save();
        }
    }

    /// Главный диспетчер: метод + параметры → результат.
    pub fn handle(&mut self, method: &str, params: &Json) -> MeshResult<Json> {
        match method {
            "hello" => Ok(self.hello()),
            "state" => Ok(self.state()),
            "signIn" => self.sign_in(&param_str(params, "token").unwrap_or_default()),
            "signOut" => {
                self.client.token = None;
                self.client.profile_id = None;
                self.client.clear_cache();
                Ok(self.state())
            }
            "refreshToken" => {
                let token = self.client.refresh_token()?;
                let mut state = self.state();
                if let Json::Obj(entries) = &mut state {
                    entries.push(("refreshed".to_string(), Json::Bool(token.is_some())));
                }
                Ok(state)
            }
            "selectStudent" => {
                let student = param_str(params, "profileId").or_else(|| param_str(params, "studentId"));
                match student {
                    Some(value) => {
                        self.client.profile_id = Some(value);
                        self.client.clear_cache();
                        Ok(self.state())
                    }
                    None => Err(MeshError::new("bad-request", "Не указан ученик (profileId/studentId)")),
                }
            }
            "profile" => Ok(self.client.profile(param_bool(params, "useCache", true))?.to_json()),
            "subjects" => {
                let person_id = self.require_person_id(params)?;
                let date = param_str(params, "date").unwrap_or_else(util::today_iso);
                let list = self.client.subjects(&person_id, &date)?;
                Ok(Json::object(vec![
                    ("date", Json::str(util::to_iso(&date))),
                    ("personId", Json::str(person_id)),
                    ("subjects", Json::Arr(list.iter().map(|item| item.to_json()).collect())),
                ]))
            }
            "subjectMarks" => {
                let student_id = self.require_student_id(params)?;
                let items = self.client.subject_marks(&student_id)?;
                Ok(Json::object(vec![("marks", Json::Arr(items))]))
            }
            "rank" => {
                let board = self.rank_board(params)?;
                Ok(board.to_json())
            }
            "marks" => {
                let student_id = self.require_student_id(params)?;
                let to = param_str(params, "to").unwrap_or_else(util::today_iso);
                let from = param_str(params, "from").unwrap_or_else(|| util::add_days(&to, -30));
                let mark_list = self.client.marks(&student_id, &from, &to)?;
                let summary = marks::summarize_marks(&mark_list);
                Ok(Json::object(vec![
                    ("from", Json::str(util::to_iso(&from))),
                    ("to", Json::str(util::to_iso(&to))),
                    ("marks", Json::Arr(mark_list.iter().map(|mark| mark.to_json()).collect())),
                    ("summary", summary.to_json()),
                ]))
            }
            "homeworks" => {
                let student_id = self.require_student_id(params)?;
                let to = param_str(params, "to").unwrap_or_else(util::today_iso);
                let from = param_str(params, "from").unwrap_or_else(|| util::add_days(&to, -7));
                let items = self.client.homeworks(&student_id, &from, &to)?;
                Ok(Json::object(vec![
                    ("from", Json::str(util::to_iso(&from))),
                    ("to", Json::str(util::to_iso(&to))),
                    (
                        "homeworks",
                        Json::Arr(items.iter().map(|item| item.to_json()).collect()),
                    ),
                ]))
            }
            "schedule" => {
                let student_id = self.require_student_id(params)?;
                let date = param_str(params, "date").unwrap_or_else(util::today_iso);
                let to = param_str(params, "to");
                let lessons = self.client.schedule(&student_id, &date, to.as_deref())?;
                Ok(Json::object(vec![
                    ("date", Json::str(util::to_iso(&date))),
                    ("lessons", Json::Arr(lessons.iter().map(|lesson| lesson.to_json()).collect())),
                ]))
            }
            "names" => {
                let ids = param_ids(params);
                Ok(Json::object(vec![("names", self.client.names_for(&ids))]))
            }
            "ping" => Ok(Json::object(vec![("ok", Json::Bool(self.client.ping()))])),
            "token.describe" => Ok(token::describe_token(
                param_str(params, "token").as_deref().or(self.client.token.as_deref()),
                util::now_ms(),
            )),
            "token.extract" => {
                let text = param_str(params, "text").unwrap_or_default();
                Ok(Json::object(vec![(
                    "token",
                    Json::text_or_null(&token::extract_token(&Json::str(text))),
                )]))
            }
            "stats.describe" => Ok(stats::describe(&param_numbers(params, "values"))),
            "rank.build" => {
                let members = param_array(params, "members");
                let names = params.get("names").cloned().unwrap_or(Json::obj());
                let me_id = param_str(params, "meId").unwrap_or_default();
                let date = param_str(params, "date").unwrap_or_else(util::today_iso);
                let subject_id = param_str(params, "subjectId");
                let subject_name = param_str(params, "subjectName");
                let board = rank::build_rank_board(
                    &members,
                    &names,
                    &me_id,
                    &date,
                    subject_id.as_deref(),
                    subject_name.as_deref(),
                );
                Ok(board.to_json())
            }
            "marks.summarize" => {
                let marks = normalize_marks(params);
                let summary = marks::summarize_marks(&marks);
                Ok(Json::object(vec![
                    ("marks", Json::Arr(mark_list.iter().map(|mark| mark.to_json()).collect())),
                    ("summary", summary.to_json()),
                ]))
            }
            "homeworks.normalize" => {
                let payload = payload_of(params);
                let mut items: Vec<Json> = Vec::new();
                for item in normalize::payload_list(&payload) {
                    items.push(normalize::normalize_homework(&item).to_json());
                }
                Ok(Json::object(vec![("homeworks", Json::Arr(items))]))
            }
            "schedule.normalize" => {
                let payload = payload_of(params);
                let lessons = normalize::normalize_schedule(&payload);
                Ok(Json::object(vec![(
                    "lessons",
                    Json::Arr(lessons.iter().map(|lesson| lesson.to_json()).collect()),
                )]))
            }
            "homeworks.deadlines" => {
                let reference = param_str(params, "reference").unwrap_or_else(util::today_iso);
                let explicit = param_array(params, "homeworks");
                if explicit.is_empty() {
                    Ok(insights::deadlines_from_payload(&payload_of(params), &reference))
                } else {
                    let mut items = Vec::new();
                    for item in explicit {
                        items.push(normalize::normalize_homework(&item));
                    }
                    Ok(insights::deadlines(&items, &reference))
                }
            }
            "insights.history" => {
                let subject = param_str(params, "subjectId");
                let snapshots = self.snapshot_list(params)?;
                Ok(insights::history_series(&snapshots, subject.as_deref()))
            }
            "insights.forecast" => {
                let mark_list = normalize_marks(params);
                let target = param_f64(params, "target").unwrap_or(4.5);
                let remaining = param_i64(params, "remaining").unwrap_or(1);
                Ok(insights::forecast(&mark_list, target, remaining))
            }
            "insights.whatIf" => {
                let mark_list = normalize_marks(params);
                let extra = param_numbers(params, "extra");
                Ok(insights::what_if(&mark_list, &extra))
            }
            "insights.impact" => {
                let mark_list = normalize_marks(params);
                let limit = param_i64(params, "limit").unwrap_or(5).max(0) as usize;
                Ok(insights::subject_impact(&mark_list, limit))
            }
            "csv.rank" => {
                // Либо «сырые» участники рейтинга, либо уже готовая таблица строк.
                let rows: Vec<Json> = if params.get("members").is_some() {
                    let members = param_array(params, "members");
                    let names = params.get("names").cloned().unwrap_or(Json::obj());
                    let me_id = param_str(params, "meId").unwrap_or_default();
                    rank::build_rank_table(&members, &names, &me_id)
                        .iter()
                        .map(|row| row.to_json())
                        .collect()
                } else {
                    param_array(params, "rows")
                };
                let title = param_str(params, "title").unwrap_or_else(|| "Рейтинг класса".to_string());
                Ok(csv_result(&rows, &rank_columns(), &title, param_str(params, "fileName")))
            }
            "csv.marks" => {
                let mark_list = normalize_marks(params);
                let rows: Vec<Json> = mark_list.iter().map(|mark| mark.to_json()).collect();
                let title = param_str(params, "title").unwrap_or_else(|| "Оценки".to_string());
                Ok(csv_result(&rows, &mark_columns(), &title, param_str(params, "fileName")))
            }
            "history.list" => {
                let store = self.history()?;
                Ok(Json::object(vec![
                    ("count", Json::Num(store.len() as f64)),
                    (
                        "snapshots",
                        Json::Arr(store.snapshots.iter().map(Snapshot::to_json).collect()),
                    ),
                ]))
            }
            "history.append" => {
                let snapshot = Snapshot::from_json(&params.clone());
                let added = self.history()?.append(snapshot);
                if let Some(store) = &self.history {
                    let _ = store.save();
                }
                let count = self.history.map(|store| store.len()).unwrap_or(0);
                Ok(Json::object(vec![
                    ("added", Json::Bool(added)),
                    ("count", Json::Num(count as f64)),
                ]))
            }
            "history.clear" => {
                let store = self.history()?;
                store.clear();
                let _ = store.save();
                Ok(Json::object(vec![("cleared", Json::Bool(true))]))
            }
            "cache.stats" => Ok(Json::object(vec![
                ("requests", Json::Num(self.client.request_count as f64)),
                ("cache", self.client.cache_stats()),
                ("names", Json::Num(self.client.name_cache().entries.len() as f64)),
            ])),
            "bench" => Ok(bench::run(
                param_i64(params, "students").unwrap_or(26).max(1) as usize,
                param_i64(params, "marks").unwrap_or(120).max(1) as usize,
                param_i64(params, "iterations").unwrap_or(50).max(1) as usize,
            )),
            other => Err(MeshError::new("unknown-method", format!("Неизвестный метод: {}", other))),
        }
    }

    fn hello(&self) -> Json {
        Json::object(vec![
            ("name", Json::str("mesh-rank")),
            ("engine", Json::str("rust")),
            ("version", Json::str(crate::VERSION)),
            ("about", Json::str(crate::about())),
            ("methods", Json::Arr(METHODS.iter().map(|item| Json::str(*item)).collect())),
            ("demo", Json::Bool(self.demo)),
            ("host", Json::str(self.client.base_url.clone())),
            ("transport", Json::str(self.client.transport_name())),
            ("loginUrl", Json::str(crate::client::login_url())),
            (
                "protocol",
                Json::object(vec![
                    ("format", Json::str("json-lines")),
                    ("version", Json::Num(1.0)),
                ]),
            ),
        ])
    }

    fn state(&self) -> Json {
        let mut state = self.client_state();
        if let Json::Obj(entries) = &mut state {
            entries.push(("cache".to_string(), self.client.cache_stats()));
            entries.push((
                "historyCount".to_string(),
                Json::Num(self.history.as_ref().map(|store| store.len()).unwrap_or(0) as f64),
            ));
            entries.push((
                "uptimeMs".to_string(),
                Json::Num((util::now_ms() - self.started_at) as f64),
            ));
        }
        state
    }

    fn client_state(&self) -> Json {
        // `MeshClient::state` требует &mut из-за счётчика запросов; для чтения
        // собираем состояние вручную — так `state` можно вызывать и &self.
        Json::object(vec![
            ("demo", Json::Bool(self.demo)),
            ("platform", Json::str("rust")),
            ("authenticated", Json::Bool(self.client.token.is_some())),
            (
                "token",
                token::describe_token(self.client.token.as_deref(), util::now_ms()),
            ),
            ("profileId", Json::text_or_null(&self.client.profile_id)),
            ("loginUrl", Json::str(crate::client::login_url())),
            ("host", Json::str(self.client.base_url.clone())),
            ("transport", Json::str(self.client.transport_name())),
            ("requests", Json::Num(self.client.request_count as f64)),
        ])
    }

    fn sign_in(&mut self, token_value: &str) -> MeshResult<Json> {
        let result = self.client.sign_in(token_value)?;
        Ok(Json::object(vec![
            ("token", Json::str(result.token.clone())),
            ("profile", result.profile.to_json()),
            (
                "child",
                match &result.child {
                    Some(child) => child.to_json(),
                    None => Json::Null,
                },
            ),
            ("profileId", Json::text_or_null(&result.profile_id)),
            ("state", self.state()),
        ]))
    }

    fn rank_board(&mut self, params: &Json) -> MeshResult<crate::model::RankBoard> {
        let person_id = self.require_person_id(params)?;
        let date = param_str(params, "date").unwrap_or_else(util::today_iso);
        let mut options = RankBoardOptions::new(&person_id, &date);
        options.subject_id = param_str(params, "subjectId");
        options.subject_name = param_str(params, "subjectName");
        options.with_names = param_bool(params, "withNames", true);
        options.use_cache = param_bool(params, "useCache", true);
        self.client.rank_board(options)
    }

    fn require_person_id(&self, params: &Json) -> MeshResult<String> {
        if let Some(value) = param_str(params, "personId") {
            if !value.is_empty() {
                return Ok(value);
            }
        }
        Err(MeshError::new("bad-request", "Не указан personId ученика"))
    }

    fn require_student_id(&self, params: &Json) -> MeshResult<String> {
        if let Some(value) = param_str(params, "studentId") {
            if !value.is_empty() {
                return Ok(value);
            }
        }
        if let Some(value) = &self.client.profile_id {
            return Ok(value.clone());
        }
        Err(MeshError::new("bad-request", "Не указан studentId ученика"))
    }

    fn snapshot_list(&mut self, params: &Json) -> MeshResult<Vec<Snapshot>> {
        let explicit = param_array(params, "snapshots");
        if !explicit.is_empty() {
            return Ok(explicit.iter().map(Snapshot::from_json).collect());
        }
        let store = self.history()?;
        Ok(store.snapshots.clone())
    }
}

// ------------------------------------------------------------- хелперы JSON --

fn param_str(params: &Json, key: &str) -> Option<String> {
    match params.get(key) {
        Some(value) if !value.is_null() => {
            let text = value.text();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn param_bool(params: &Json, key: &str, fallback: bool) -> bool {
    params.get(key).and_then(Json::as_bool).unwrap_or(fallback)
}

fn param_i64(params: &Json, key: &str) -> Option<i64> {
    params.get(key).and_then(Json::as_i64)
}

fn param_f64(params: &Json, key: &str) -> Option<f64> {
    params.get(key).and_then(Json::as_f64)
}

fn param_array(params: &Json, key: &str) -> Vec<Json> {
    params
        .get(key)
        .and_then(Json::as_arr)
        .map(|items| items.to_vec())
        .unwrap_or_default()
}

fn param_numbers(params: &Json, key: &str) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for item in param_array(params, key) {
        if let Some(value) = item.as_f64() {
            if value.is_finite() {
                out.push(value);
            }
        }
    }
    out
}

/// `personIds` может быть как строкой «a,b», так и массивом.
fn param_ids(params: &Json) -> Vec<String> {
    match params.get("personIds") {
        Some(Json::Arr(items)) => items.iter().map(Json::text).filter(|id| !id.is_empty()).collect(),
        Some(value) => value
            .text()
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        None => Vec::new(),
    }
}

fn item_text(item: &Json, keys: &[&str]) -> String {
    item.pick_text(keys)
}

/// `payload` / `homeworks` / `marks` / весь объект — что угодно.
fn payload_of(params: &Json) -> Json {
    for key in ["payload", "homeworks", "marks", "data"] {
        if let Some(value) = params.get(key) {
            return value.clone();
        }
    }
    params.clone()
}

fn normalize_marks(params: &Json) -> Vec<Mark> {
    let mut marks: Vec<Mark> = Vec::new();
    let source = [
        param_array(params, "marks"),
        param_array(params, "payload"),
        param_array(params, "items"),
    ];
    for list in source {
        if list.is_empty() {
            continue;
        }
        for item in list {
            marks.push(normalize::normalize_mark(&item));
        }
        break;
    }
    marks
}

fn csv_result(rows: &[Json], columns: &[Column], title: &str, file_name: Option<String>) -> Json {
    let csv = format::to_csv(rows, columns, Some(title), ';', true);
    let name = file_name.unwrap_or_else(|| format::export_file_name("rating", &util::today_iso(), "csv"));
    Json::object(vec![
        ("csv", Json::str(csv.clone())),
        ("fileName", Json::str(name)),
        ("rows", Json::Num(rows.len() as f64)),
        ("bytes", Json::Num(csv.len() as f64)),
    ])
}

fn rank_columns() -> Vec<Column> {
    vec![
        Column::new("place", "Место", ColumnFormat::Place),
        Column::new("name", "Ученик", ColumnFormat::Raw),
        Column::new("average", "Средний балл", ColumnFormat::Mark),
        Column::new("previousAverage", "Было", ColumnFormat::Mark),
        Column::new("averageDelta", "Δ балла", ColumnFormat::Mark),
        Column::new("placeDelta", "Δ места", ColumnFormat::Raw),
        Column::new("status", "Статус", ColumnFormat::Raw),
    ]
}

fn mark_columns() -> Vec<Column> {
    vec![
        Column::new("date", "Дата", ColumnFormat::Date),
        Column::new("subjectName", "Предмет", ColumnFormat::Raw),
        Column::new("value", "Оценка", ColumnFormat::Mark),
        Column::new("weight", "Вес", ColumnFormat::Raw),
        Column::new("controlForm", "Форма контроля", ColumnFormat::Raw),
        Column::new("comment", "Комментарий", ColumnFormat::Raw),
    ]
}

/// Пути по умолчанию внутри проекта — используется CLI и мостом.
pub fn default_paths(root: &std::path::Path) -> (PathBuf, PathBuf, PathBuf) {
    (
        root.join("school-mos-ru.json"),
        root.join(".mesh-ranker").join("history.json"),
        root.join(".mesh-ranker").join("users_cache.json"),
    )
}

/// Диагностика: список методов ядра (для `/api/native` и CLI).
pub fn describe() -> Json {
    Json::object(vec![
        ("engine", Json::str("rust")),
        ("version", Json::str(crate::VERSION)),
        ("about", Json::str(crate::about())),
        ("methods", Json::Arr(METHODS.iter().map(|item| Json::str(*item)).collect())),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_describes_the_core() {
        let mut session = Session::new(SessionOptions::default());
        let hello = session.handle("hello", &Json::obj()).expect("hello");
        assert_eq!(hello.get("name").map(Json::text), Some("mesh-rank".to_string()));
        assert_eq!(hello.get("engine").map(Json::text), Some("rust".to_string()));
        assert!(hello.get("methods").and_then(Json::as_arr).unwrap().len() >= 30);
    }

    #[test]
    fn rank_build_works_without_network() {
        let mut session = Session::new(SessionOptions::default());
        let params = Json::parse(
            r#"{"members":[
                 {"personId":"a","rank":{"averageMarkFive":5,"rankPlace":1}},
                 {"personId":"b","rank":{"averageMarkFive":4,"rankPlace":2}}],
                "names":{"a":"Иванов Иван","b":"Петров Пётр"},
                "meId":"b","date":"2026-10-12"}"#,
        )
        .expect("json");
        let board = session.handle("rank.build", &params).expect("board");
        let rows = board.get("rows").and_then(Json::as_arr).expect("строки").to_vec();
        assert_eq!(rows.len(), 2);
        assert_eq!(board.get_path("summary.myPlace").and_then(Json::as_i64), Some(2));
        assert_eq!(rows[1].get("name").map(Json::text), Some("Петров Пётр".to_string()));
        assert_eq!(rows[1].get("isMe").and_then(Json::as_bool), Some(true));
    }

    #[test]
    fn insights_work_from_bridge() {
        let mut session = Session::new(SessionOptions::default());
        let params = Json::parse(
            r#"{"marks":[{"value":5,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-01"},
                          {"value":4,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-02"}],
                "target":4.6,"remaining":1}"#,
        )
        .expect("json");
        let plan = session.handle("insights.forecast", &params).expect("прогноз");
        assert_eq!(plan.get("status").map(Json::text), Some("achievable".to_string()));
        let impact = session.handle("insights.impact", &params).expect("влияние");
        assert_eq!(impact.as_arr().map(|rows| rows.len()), Some(1));
    }

    #[test]
    fn deadlines_from_payload() {
        let mut session = Session::new(SessionOptions::default());
        let params = Json::parse(
            r#"{"payload":[{"homework_id":"h1","subject_name":"История","description":"§ 12","date_prepared":"2026-10-10"},
                           {"homework_id":"h2","subject_name":"Алгебра","description":"Номера","date_prepared":"2026-10-13"}],
                "reference":"2026-10-13"}"#,
        )
        .expect("json");
        let report = session.handle("homeworks.deadlines", &params).expect("дедлайны");
        assert_eq!(report.get("total").and_then(Json::as_i64), Some(2));
        assert_eq!(report.get("overdue").and_then(Json::as_i64), Some(1));
    }

    #[test]
    fn csv_export_contains_header_and_rows() {
        let mut session = Session::new(SessionOptions::default());
        let params = Json::parse(
            r#"{"members":[{"personId":"a","rank":{"averageMarkFive":4.75,"rankPlace":1}}],
                "names":{"a":"Иванов Иван"},"title":"Рейтинг класса"}"#,
        )
        .expect("json");
        let result = session.handle("csv.rank", &params).expect("csv");
        let csv = result.get("csv").map(Json::text).unwrap_or_default();
        assert!(csv.contains("Иванов Иван"));
        assert!(csv.contains("4.75"));
        assert!(csv.starts_with('\u{feff}'));
    }

    #[test]
    fn history_is_persisted_in_a_file() {
        let mut path = std::env::temp_dir();
        path.push(format!("mesh-history-{}.json", util::now_ms()));
        let mut session = Session::new(SessionOptions {
            history_path: Some(path.clone()),
            ..SessionOptions::default()
        });
        let snapshot = Json::parse(
            r#"{"date":"2026-10-12","myPlace":5,"myAverage":4.4,"classAverage":4.0,"total":26}"#,
        )
        .expect("json");
        let appended = session.handle("history.append", &snapshot).expect("история");
        assert_eq!(appended.get("added").and_then(Json::as_bool), Some(true));
        let list = session.handle("history.list", &Json::obj()).expect("список");
        assert_eq!(list.get("count").and_then(Json::as_i64), Some(1));
        let series = session
            .handle("insights.history", &Json::obj())
            .expect("динамика");
        assert_eq!(series.get("count").and_then(Json::as_i64), Some(1));
        let cleared = session.handle("history.clear", &Json::obj()).expect("очистка");
        assert_eq!(cleared.get("cleared").and_then(Json::as_bool), Some(true));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unknown_method_is_reported() {
        let mut session = Session::new(SessionOptions::default());
        let error = session.handle("нет-такого", &Json::obj()).unwrap_err();
        assert_eq!(error.code, "unknown-method");
        assert!(error.describe().contains("Неизвестный метод"));
    }

    #[test]
    fn bench_reports_speed() {
        let mut session = Session::new(SessionOptions::default());
        let params = Json::parse(r#"{"students":26,"marks":60,"iterations":10}"#).expect("json");
        let report = session.handle("bench", &params).expect("бенчмарк");
        assert!(report.get_path("timings.rankTablePerSecond").and_then(Json::as_f64).unwrap_or(0.0) > 0.0);
    }
}
