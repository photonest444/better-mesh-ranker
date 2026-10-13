//! Клиент МЭШ на Rust: запросы, автообновление токена, имена учеников,
//! рейтинг класса и оценки. Используется нативным CLI и мостом для Node.

use std::time::Duration;

use crate::cache::{NameCache, ResponseCache};
use crate::error::{MeshError, MeshResult};
use crate::http::{HttpClient, Request};
use crate::json::Json;
use crate::model::{Child, Homework, Lesson, Mark, Profile, RankBoard, Subject};
use crate::normalize;
use crate::rank;
use crate::token;
use crate::util;

/// Адрес боевого МЭШ.
pub const HOST: &str = "https://school.mos.ru";
pub const ROLE_ID: &str = "1";
pub const SUBSYSTEM: &str = "familyweb";
pub const SUBSYSTEM_ID: &str = "2";
pub const PROFILE_TYPE: &str = "student";

const USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

/// Пути методов МЭШ (совпадают с JS-ядром `MeshCore.PATHS`).
pub mod paths {
    pub const PROFILE: &str = "/api/family/web/v1/profile";
    pub const PROFILE_BY_ID: &str = "/api/gamification/v1/profiles";
    pub const SUBJECTS: &str = "/api/ej/rating/v1/rank/subjects";
    pub const RANK: &str = "/api/ej/rating/v1/rank/class";
    pub const MARKS: &str = "/api/family/web/v1/marks";
    pub const SUBJECT_MARKS: &str = "/api/family/web/v1/subject_marks";
    pub const HOMEWORKS: &str = "/api/family/web/v1/homeworks";
    pub const SCHEDULE: &str = "/api/family/web/v1/schedule";
    pub const TOKEN_REFRESH: &str = "/v2/token/refresh";
    pub const USER_INFO: &str = "/v3/userinfo";
}

/// Ссылка на страницу входа (после входа МЭШ отдаёт свежий токен).
pub fn login_url() -> String {
    format!("{}{}?roleId={}&subsystem={}", HOST, paths::TOKEN_REFRESH, ROLE_ID, SUBSYSTEM_ID)
}

/// Настройки клиента.
pub struct ClientOptions {
    pub base_url: String,
    pub token: Option<String>,
    pub profile_id: Option<String>,
    pub timeout: Duration,
    pub auto_refresh: bool,
    pub cache_ttl_ms: i64,
    pub name_cache: NameCache,
}

impl Default for ClientOptions {
    fn default() -> ClientOptions {
        ClientOptions {
            base_url: HOST.to_string(),
            token: None,
            profile_id: None,
            timeout: Duration::from_secs(15),
            auto_refresh: true,
            cache_ttl_ms: 30_000,
            name_cache: NameCache::in_memory(),
        }
    }
}

impl ClientOptions {
    pub fn demo(base_url: &str, token: &str) -> ClientOptions {
        ClientOptions {
            base_url: base_url.to_string(),
            token: Some(token.to_string()),
            ..ClientOptions::default()
        }
    }
}

/// Результат входа.
#[derive(Clone, Debug)]
pub struct SignInResult {
    pub token: String,
    pub profile: Profile,
    pub child: Option<Child>,
    pub profile_id: Option<String>,
}

/// Опции сборки таблицы рейтинга.
#[derive(Clone, Debug, Default)]
pub struct RankBoardOptions {
    pub person_id: String,
    pub date: String,
    pub subject_id: Option<String>,
    pub subject_name: Option<String>,
    pub with_names: bool,
    pub use_cache: bool,
}

impl RankBoardOptions {
    pub fn new(person_id: &str, date: &str) -> RankBoardOptions {
        RankBoardOptions {
            person_id: person_id.to_string(),
            date: date.to_string(),
            subject_id: None,
            subject_name: None,
            with_names: true,
            use_cache: true,
        }
    }
}

/// Клиент МЭШ.
pub struct MeshClient {
    pub base_url: String,
    pub token: Option<String>,
    pub profile_id: Option<String>,
    pub timeout: Duration,
    pub auto_refresh: bool,
    pub request_count: usize,
    pub last_error: Option<MeshError>,
    pub allow_loose_token: bool,
    http: HttpClient,
    cache: ResponseCache,
    names: NameCache,
}

impl MeshClient {
    pub fn new(options: ClientOptions) -> MeshClient {
        let base_url = options.base_url.trim_end_matches('/').to_string();
        let allow_loose_token = base_url.starts_with("http://127.0.0.1")
            || base_url.starts_with("http://localhost")
            || base_url.starts_with("http://[::1]");
        MeshClient {
            base_url,
            token: options.token,
            profile_id: options.profile_id,
            timeout: options.timeout,
            auto_refresh: options.auto_refresh,
            request_count: 0,
            last_error: None,
            allow_loose_token,
            http: HttpClient::auto(),
            cache: ResponseCache::new(options.cache_ttl_ms),
            names: options.name_cache,
        }
    }

    pub fn transport_name(&self) -> &'static str {
        self.http.transport_name()
    }

    pub fn name_cache(&self) -> &NameCache {
        &self.names
    }

    pub fn name_cache_mut(&mut self) -> &mut NameCache {
        &mut self.names
    }

    pub fn cache_stats(&self) -> Json {
        self.cache.stats()
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    // ------------------------------------------------------------- заголовки --

    pub fn base_headers(&self) -> Vec<(String, String)> {
        vec![
            ("Accept".to_string(), "application/json, text/plain, */*".to_string()),
            ("Accept-Language".to_string(), "ru-RU,ru;q=0.9".to_string()),
            ("Content-Type".to_string(), "application/json;charset=UTF-8".to_string()),
            ("Profile-Type".to_string(), PROFILE_TYPE.to_string()),
            ("User-Agent".to_string(), USER_AGENT.to_string()),
            ("X-Mes-RoleId".to_string(), ROLE_ID.to_string()),
            ("X-Mes-Subsystem".to_string(), SUBSYSTEM.to_string()),
        ]
    }

    pub fn auth_headers(&self) -> Vec<(String, String)> {
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(token) = &self.token {
            headers.push(("Authorization".to_string(), format!("Bearer {}", token)));
            headers.push(("Auth-Token".to_string(), token.clone()));
        }
        if let Some(profile_id) = &self.profile_id {
            headers.push(("Profile-Id".to_string(), profile_id.clone()));
        }
        headers
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut headers = self.base_headers();
        headers.extend(self.auth_headers());
        headers
    }

    /// Сборка адреса с query-параметрами (`None` и пустые значения пропускаются).
    pub fn build_url(&self, path: &str, params: &[(&str, Option<String>)]) -> String {
        let mut url = format!("{}{}", self.base_url, path);
        let mut query: Vec<String> = Vec::new();
        for (key, value) in params {
            if let Some(value) = value {
                if !value.is_empty() {
                    query.push(format!("{}={}", util::url_encode(key), util::url_encode(value)));
                }
            }
        }
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query.join("&"));
        }
        url
    }

    // --------------------------------------------------------------- запросы --

    /// GET с TTL-кэшем, понятными ошибками и автообновлением токена при 401.
    pub fn request(
        &mut self,
        path: &str,
        params: &[(&str, Option<String>)],
        use_cache: bool,
    ) -> MeshResult<Json> {
        let url = self.build_url(path, params);
        let cache_key = format!("GET {}", url);
        if use_cache {
            if let Some(cached) = self.cache.get(&cache_key) {
                return Ok(cached);
            }
        }

        let max_attempts = if self.auto_refresh { 2 } else { 1 };
        let mut attempt = 0;
        let mut last_error = MeshError::new("exhausted", format!("Запрос не выполнен: {}", path));
        while attempt < max_attempts {
            attempt += 1;
            let request = Request::get(&url, self.headers());
            self.request_count += 1;
            let response = match self.http.send(&request, self.timeout) {
                Ok(value) => value,
                Err(error) => {
                    self.last_error = Some(error.clone());
                    return Err(error);
                }
            };

            if response.status == 401 {
                if attempt < max_attempts {
                    let refreshed = self.refresh_token()?;
                    if refreshed.is_some() {
                        continue;
                    }
                    last_error = MeshError::new("unauthorized", "Токен истёк, обновить не удалось").with_status(401);
                } else {
                    last_error = MeshError::unauthorized();
                }
                self.last_error = Some(last_error.clone());
                return Err(last_error);
            }
            if response.status == 403 {
                let error = MeshError::forbidden();
                self.last_error = Some(error.clone());
                return Err(error);
            }
            if response.status == 404 {
                let error = MeshError::not_found(path);
                self.last_error = Some(error.clone());
                return Err(error);
            }
            if !response.is_ok() {
                let error = MeshError::http(response.status, path);
                self.last_error = Some(error.clone());
                return Err(error);
            }
            let value = match response.json() {
                Ok(value) => value,
                Err(error) => {
                    // МЭШ иногда отдаёт токен текстом вместо JSON — разбираем и это.
                    if let Some(found) = token::extract_token_from_text(&response.body) {
                        Json::object(vec![("token", Json::str(found))])
                    } else {
                        self.last_error = Some(error.clone());
                        return Err(error);
                    }
                }
            };
            if use_cache {
                self.cache.set(&cache_key, value.clone());
            }
            return Ok(value);
        }
        Err(last_error)
    }

    /// Обновление токена: `GET /v2/token/refresh?roleId=1&subsystem=2`.
    pub fn refresh_token(&mut self) -> MeshResult<Option<String>> {
        let token = match &self.token {
            Some(value) if !value.is_empty() => value.clone(),
            _ => return Ok(None),
        };
        let url = self.build_url(
            paths::TOKEN_REFRESH,
            &[
                ("roleId", Some(ROLE_ID.to_string())),
                ("subsystem", Some(SUBSYSTEM_ID.to_string())),
            ],
        );
        let request = Request::get(&url, self.headers());
        self.request_count += 1;
        let response = match self.http.send(&request, self.timeout) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let mut found = token::extract_token_from_text(&response.body)
            .or_else(|| token::extract_token_from_url(&url));
        if found.is_none() && self.allow_loose_token {
            found = token::extract_loose_token(&response.body);
        }
        match found {
            Some(value) if response.is_ok() && value != token => {
                self.token = Some(value.clone());
                self.cache.clear();
                Ok(Some(value))
            }
            _ => Ok(None),
        }
    }

    /// Профиль родителя и дети.
    pub fn profile(&mut self, use_cache: bool) -> MeshResult<Profile> {
        let value = self.request(paths::PROFILE, &[], use_cache)?;
        Ok(normalize::normalize_profile(&value))
    }

    /// Вход по токену: проверяет токен, тянет профиль, определяет ученика.
    pub fn sign_in(&mut self, token: &str) -> MeshResult<SignInResult> {
        let candidate = match token::extract_token(&Json::str(token)) {
            Some(value) => value,
            None => token.trim().to_string(),
        };
        if candidate.is_empty() {
            return Err(MeshError::bad_token("Токен МЭШ пустой — вставьте значение целиком"));
        }
        if !token::looks_like_token(&candidate) && !self.allow_loose_token {
            return Err(MeshError::bad_token("Не похоже на токен МЭШ — скопируйте значение целиком"));
        }
        self.token = Some(candidate.clone());
        self.cache.clear();
        let profile = self.profile(false)?;
        let child = profile.default_child().cloned();
        self.profile_id = child.as_ref().map(|item| item.id.clone());
        Ok(SignInResult { token: candidate, profile, child, profile_id: self.profile_id.clone() })
    }

    /// Предметы с местами ученика.
    pub fn subjects(&mut self, person_id: &str, date: &str) -> MeshResult<Vec<Subject>> {
        let value = self.request(
            paths::SUBJECTS,
            &[
                ("date", Some(util::to_iso(date))),
                ("personId", Some(person_id.to_string())),
            ],
            true,
        )?;
        let mut subjects: Vec<Subject> = Vec::new();
        for item in normalize::payload_list(&value) {
            subjects.push(normalize::normalize_subject(&item));
        }
        Ok(subjects)
    }

    /// Итоговые оценки по предметам (как отдаёт МЭШ).
    pub fn subject_marks(&mut self, student_id: &str) -> MeshResult<Vec<Json>> {
        let value = self.request(
            paths::SUBJECT_MARKS,
            &[("student_id", Some(student_id.to_string()))],
            true,
        )?;
        Ok(normalize::payload_list(&value))
    }

    /// Сырые строки рейтинга класса.
    pub fn rank(&mut self, person_id: &str, date: &str, subject_id: Option<&str>) -> MeshResult<Vec<Json>> {
        let value = self.request(
            paths::RANK,
            &[
                ("personId", Some(person_id.to_string())),
                ("date", Some(util::to_iso(date))),
                ("subjectId", subject_id.map(|item| item.to_string())),
            ],
            true,
        )?;
        Ok(normalize::payload_list(&value))
    }

    /// Имя ученика по personId (с кэшем; ошибки не выходят наружу).
    pub fn name_for(&mut self, person_id: &str) -> String {
        if person_id.trim().is_empty() {
            return "Неизвестный ученик".to_string();
        }
        if let Some(cached) = self.names.get(person_id) {
            return cached;
        }
        let value = match self.request(
            paths::PROFILE_BY_ID,
            &[("personId", Some(person_id.to_string()))],
            true,
        ) {
            Ok(value) => value,
            Err(_) => {
                let fallback = rank::short_id(person_id);
                self.names.set(person_id, &fallback);
                return fallback;
            }
        };
        let last = value.pick_text(&["lastName", "last_name"]);
        let first = value.pick_text(&["firstName", "first_name"]);
        let middle = value.pick_text(&["middleName"]);
        let mut name = normalize::person_name(&[&last, &first, &middle]);
        if name.is_empty() {
            name = value.pick_text(&["name"]);
        }
        if name.is_empty() {
            name = rank::short_id(person_id);
        }
        self.names.set(person_id, &name);
        name
    }

    /// Имена для списка personId — объект `{"id": "Фамилия Имя"}`.
    pub fn names_for(&mut self, person_ids: &[String]) -> Json {
        let mut entries: Vec<(String, Json)> = Vec::new();
        for id in person_ids {
            if id.trim().is_empty() {
                continue;
            }
            if entries.iter().any(|(key, _)| key == id) {
                continue;
            }
            let name = self.name_for(id);
            entries.push((id.clone(), Json::str(name)));
        }
        Json::Obj(entries)
    }

    /// Таблица рейтинга с именами и сводкой — то, что показывает вкладка «Рейтинг».
    pub fn rank_board(&mut self, options: RankBoardOptions) -> MeshResult<RankBoard> {
        let date = if options.date.trim().is_empty() { util::today_iso() } else { util::to_iso(&options.date) };
        let members = self.rank(&options.person_id, &date, options.subject_id.as_deref())?;

        let mut names = Json::obj();
        if options.with_names {
            let mut ids: Vec<String> = Vec::new();
            for member in &members {
                let id = member.pick_text(&["personId", "person_id"]);
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
            names = self.names_for(&ids);
        }

        Ok(rank::build_rank_board(
            &members,
            &names,
            &options.person_id,
            &date,
            options.subject_id.as_deref(),
            options.subject_name.as_deref(),
        ))
    }

    /// Оценки за период.
    pub fn marks(&mut self, student_id: &str, from: &str, to: &str) -> MeshResult<Vec<Mark>> {
        let value = self.request(
            paths::MARKS,
            &[
                ("student_id", Some(student_id.to_string())),
                ("from", Some(util::to_iso(from))),
                ("to", Some(util::to_iso(to))),
            ],
            true,
        )?;
        let mut marks: Vec<Mark> = Vec::new();
        for item in normalize::marks_payload(&value) {
            marks.push(normalize::normalize_mark(&item));
        }
        Ok(marks)
    }

    /// Домашние задания за период.
    pub fn homeworks(&mut self, student_id: &str, from: &str, to: &str) -> MeshResult<Vec<Homework>> {
        let value = self.request(
            paths::HOMEWORKS,
            &[
                ("student_id", Some(student_id.to_string())),
                ("from", Some(util::to_iso(from))),
                ("to", Some(util::to_iso(to))),
            ],
            true,
        )?;
        let mut items: Vec<Homework> = Vec::new();
        for item in normalize::payload_list(&value) {
            items.push(normalize::normalize_homework(&item));
        }
        Ok(items)
    }

    /// Расписание на дату (или диапазон).
    pub fn schedule(&mut self, student_id: &str, date: &str, to: Option<&str>) -> MeshResult<Vec<Lesson>> {
        let value = self.request(
            paths::SCHEDULE,
            &[
                ("student_id", Some(student_id.to_string())),
                ("date", Some(util::to_iso(date))),
                ("to", to.map(|item| util::to_iso(item))),
            ],
            true,
        )?;
        Ok(normalize::normalize_schedule(&value))
    }

    /// Проверка соединения.
    pub fn ping(&mut self) -> bool {
        match self.profile(false) {
            Ok(_) => true,
            Err(error) => {
                self.last_error = Some(error);
                false
            }
        }
    }

    /// Состояние сессии в том же виде, что у платформенных слоёв.
    pub fn state(&mut self, demo: bool) -> Json {
        let token_info = token::describe_token(self.token.as_deref(), util::now_ms());
        Json::object(vec![
            ("demo", Json::Bool(demo)),
            ("platform", Json::str("rust")),
            ("authenticated", Json::Bool(self.token.is_some())),
            ("token", token_info),
            ("profileId", Json::text_or_null(&self.profile_id)),
            ("loginUrl", Json::str(login_url())),
            ("host", Json::str(self.base_url.clone())),
            ("transport", Json::str(self.transport_name())),
            ("requests", Json::Num(self.request_count as f64)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_built_like_js_core() {
        let client = MeshClient::new(ClientOptions::default());
        let url = client.build_url(
            paths::RANK,
            &[
                ("personId", Some("uuid-1".to_string())),
                ("date", Some("2026-10-12".to_string())),
                ("subjectId", None),
            ],
        );
        assert_eq!(
            url,
            "https://school.mos.ru/api/ej/rating/v1/rank/class?personId=uuid-1&date=2026-10-12"
        );
    }

    #[test]
    fn login_url_points_to_token_refresh() {
        assert!(login_url().contains("/v2/token/refresh?roleId=1&subsystem=2"));
    }

    #[test]
    fn loose_tokens_allowed_only_for_localhost() {
        let demo = MeshClient::new(ClientOptions::demo("http://127.0.0.1:8787", "mock-token-1"));
        assert!(demo.allow_loose_token);
        let strict = MeshClient::new(ClientOptions::default());
        assert!(!strict.allow_loose_token);
    }

    #[test]
    fn sign_in_checks_token_format_for_real_host() {
        let mut client = MeshClient::new(ClientOptions::default());
        let error = client.sign_in("короткая-строка").unwrap_err();
        assert_eq!(error.code, "bad-token");
    }

    #[test]
    fn state_reports_transport_and_token() {
        let mut client = MeshClient::new(ClientOptions::default());
        client.token = Some("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc1234567".to_string());
        let state = client.state(false);
        assert_eq!(state.get("authenticated").and_then(Json::as_bool), Some(true));
        assert_eq!(state.get("platform").map(Json::text), Some("rust".to_string()));
        assert_eq!(
            state.get_path("token.kind").map(Json::text),
            Some("jwt".to_string())
        );
    }
}
