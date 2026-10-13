//! Локальные кэши нативного ядра: имена учеников, файл токена, ответы МЭШ
//! (TTL-кэш в памяти) и локальная история снимков рейтинга.

use std::fs;
use std::path::{Path, PathBuf};

use crate::insights::Snapshot;
use crate::json::Json;
use crate::util;

/// Читает JSON-файл (нет файла или битый JSON → `None`, без паники).
pub fn read_json_file(path: &Path) -> Option<Json> {
    let text = fs::read_to_string(path).ok()?;
    Json::parse(&text).ok()
}

/// Пишет JSON-файл (создаёт каталоги, права 0600 для файлов с токеном).
pub fn write_json_file(path: &Path, value: &Json, private: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, value.to_json_pretty())?;
    // Файлы авторизации закрываем правами «только владелец» (как это делают
    // Electron safeStorage и Android EncryptedSharedPreferences).
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = private;
    Ok(())
}

// ------------------------------------------------------------- имена учеников --

/// Кэш имён: `personId → «Фамилия Имя»`. Формат совместим с `users_cache.json`
/// исходного Python-скрипта и с JS-ядром.
#[derive(Clone, Debug, Default)]
pub struct NameCache {
    pub entries: Vec<(String, String)>,
    pub path: Option<PathBuf>,
}

impl NameCache {
    pub fn load(path: &Path) -> NameCache {
        let mut cache = NameCache { entries: Vec::new(), path: Some(path.to_path_buf()) };
        if let Some(value) = read_json_file(path) {
            let source = value.get("users").unwrap_or(&value);
            if let Json::Obj(items) = source {
                for (key, item) in items {
                    let name = item.text();
                    if !key.is_empty() && !name.is_empty() {
                        cache.entries.push((key.clone(), name));
                    }
                }
            }
        }
        cache
    }

    pub fn in_memory() -> NameCache {
        NameCache { entries: Vec::new(), path: None }
    }

    pub fn get(&self, person_id: &str) -> Option<String> {
        for (key, name) in &self.entries {
            if key == person_id {
                return Some(name.clone());
            }
        }
        None
    }

    pub fn set(&mut self, person_id: &str, name: &str) {
        for (key, value) in self.entries.iter_mut() {
            if key == person_id {
                *value = name.to_string();
                return;
            }
        }
        self.entries.push((person_id.to_string(), name.to_string()));
    }

    pub fn to_json(&self) -> Json {
        Json::object(vec![(
            "users",
            Json::Obj(self.entries.iter().map(|(key, value)| (key.clone(), Json::str(value.clone()))).collect()),
        )])
    }

    pub fn save(&self) -> std::io::Result<()> {
        match &self.path {
            Some(path) => write_json_file(path, &self.to_json(), false),
            None => Ok(()),
        }
    }
}

// ------------------------------------------------------------------ токен ----

/// Файл авторизации — тот же формат, что у `ranker.py`/JS-ядра
/// (`school-mos-ru.json`): token + Profile-Id + contingent_guid + имя.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenFile {
    pub token: String,
    pub profile_id: String,
    pub name: String,
    pub contingent_guid: String,
}

impl TokenFile {
    pub fn load(path: &Path) -> Option<TokenFile> {
        let value = read_json_file(path)?;
        let token = value.get("token").map(Json::text).unwrap_or_default();
        if token.trim().is_empty() {
            return None;
        }
        Some(TokenFile {
            token,
            profile_id: value.get("Profile-Id").map(Json::text).unwrap_or_default(),
            name: value.get("name").map(Json::text).unwrap_or_default(),
            contingent_guid: value.get("contingent_guid").map(Json::text).unwrap_or_default(),
        })
    }

    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("token", Json::str(self.token.clone())),
            ("Profile-Id", Json::str(self.profile_id.clone())),
            ("name", Json::str(self.name.clone())),
            ("contingent_guid", Json::str(self.contingent_guid.clone())),
        ])
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_json_file(path, &self.to_json(), true)
    }
}

// -------------------------------------------------------------- ответы МЭШ ---

/// TTL-кэш ответов (одна сессия CLI/моста). Держит ограниченное число записей,
/// поэтому память не растёт бесконечно на длинных сессиях.
pub struct ResponseCache {
    ttl_ms: i64,
    capacity: usize,
    entries: Vec<(String, i64, Json)>,
    pub hits: usize,
    pub misses: usize,
    pub evictions: usize,
}

impl ResponseCache {
    pub fn new(ttl_ms: i64) -> ResponseCache {
        ResponseCache {
            ttl_ms: ttl_ms.max(0),
            capacity: 256,
            entries: Vec::new(),
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub fn disabled() -> ResponseCache {
        ResponseCache::new(0)
    }

    pub fn get(&mut self, key: &str) -> Option<Json> {
        if self.ttl_ms <= 0 {
            self.misses += 1;
            return None;
        }
        let now = util::now_ms();
        let mut found: Option<(usize, Json)> = None;
        for (index, (existing, stamp, value)) in self.entries.iter().enumerate() {
            if existing == key {
                if now - *stamp <= self.ttl_ms {
                    found = Some((index, value.clone()));
                }
                break;
            }
        }
        match found {
            Some((index, value)) => {
                // Освежаем запись и ставим её в конец (LRU).
                if let Some(entry) = self.entries.remove(index) {
                    self.entries.push(entry);
                }
                self.hits += 1;
                Some(value)
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    pub fn set(&mut self, key: &str, value: Json) {
        if self.ttl_ms <= 0 {
            return;
        }
        let now = util::now_ms();
        for (existing, stamp, stored) in self.entries.iter_mut() {
            if existing == key {
                *stamp = now;
                *stored = value;
                return;
            }
        }
        if self.entries.len() >= self.capacity {
            self.entries.remove(0);
            self.evictions += 1;
        }
        self.entries.push((key.to_string(), now, value));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn stats(&self) -> Json {
        Json::object(vec![
            ("entries", Json::Num(self.entries.len() as f64)),
            ("hits", Json::Num(self.hits as f64)),
            ("misses", Json::Num(self.misses as f64)),
            ("evictions", Json::Num(self.evictions as f64)),
            ("ttlMs", Json::Num(self.ttl_ms as f64)),
        ])
    }
}

// ---------------------------------------------------- история снимков рейтинга --

/// Локальная история: приложение само сохраняет снимки рейтинга, чтобы
/// показывать динамику даже без отдельного метода МЭШ.
pub struct HistoryStore {
    pub path: PathBuf,
    pub snapshots: Vec<Snapshot>,
    limit: usize,
}

impl HistoryStore {
    pub fn load(path: &Path) -> HistoryStore {
        let mut store = HistoryStore { path: path.to_path_buf(), snapshots: Vec::new(), limit: 500 };
        if let Some(value) = read_json_file(path) {
            let items = value
                .get("snapshots")
                .and_then(Json::as_arr)
                .map(|items| items.to_vec())
                .unwrap_or_default();
            for item in items {
                store.snapshots.push(Snapshot::from_json(&item));
            }
        }
        store
    }

    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("version", Json::Num(1.0)),
            (
                "snapshots",
                Json::Arr(self.snapshots.iter().map(Snapshot::to_json).collect()),
            ),
        ])
    }

    pub fn save(&self) -> std::io::Result<()> {
        write_json_file(&self.path, &self.to_json(), false)
    }

    /// Добавляет снимок; повторный снимок той же даты и предмета заменяет старый.
    pub fn append(&mut self, snapshot: Snapshot) -> bool {
        for existing in self.snapshots.iter_mut() {
            if existing.date == snapshot.date && existing.subject_id == snapshot.subject_id {
                let is_new = existing.my_place != snapshot.my_place
                    || existing.my_average != snapshot.my_average
                    || existing.class_average != snapshot.class_average;
                *existing = snapshot;
                return is_new;
            }
        }
        self.snapshots.push(snapshot);
        if self.snapshots.len() > self.limit {
            let excess = self.snapshots.len() - self.limit;
            self.snapshots.drain(0..excess);
        }
        true
    }

    pub fn clear(&mut self) {
        self.snapshots.clear();
    }

    pub fn len(&self) -> usize {
        self.snapshots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.snapshots.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("mesh-core-test-{}-{}", util::now_ms(), name));
        path
    }

    #[test]
    fn name_cache_roundtrip() {
        let path = temp_path("names.json");
        let mut cache = NameCache::load(&path);
        cache.set("uuid-1", "Иванов Иван");
        cache.save().expect("сохранение");
        let loaded = NameCache::load(&path);
        assert_eq!(loaded.get("uuid-1").as_deref(), Some("Иванов Иван"));
        // Совместимость с плоским форматом (без обёртки "users").
        let flat = Json::parse(r#"{"uuid-2":"Петров Пётр"}"#).expect("json");
        write_json_file(&path, &flat, false).expect("запись");
        assert_eq!(NameCache::load(&path).get("uuid-2").as_deref(), Some("Петров Пётр"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn token_file_roundtrip() {
        let path = temp_path("auth.json");
        let token = TokenFile {
            token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc1234567".to_string(),
            profile_id: "17234613".to_string(),
            name: "Демидова Ольга".to_string(),
            contingent_guid: "uuid-me".to_string(),
        };
        token.save(&path).expect("сохранение");
        let loaded = TokenFile::load(&path).expect("загрузка");
        assert_eq!(loaded.profile_id, "17234613");
        assert_eq!(loaded.contingent_guid, "uuid-me");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn response_cache_hits_and_expires() {
        let mut cache = ResponseCache::new(60_000);
        let key = "GET /api/state";
        assert!(cache.get(key).is_none());
        cache.set(key, Json::str("данные"));
        assert_eq!(cache.get(key).map(Json::text), Some("данные".to_string()));
        assert_eq!(cache.hits, 1);
        assert_eq!(cache.misses, 1);
        assert_eq!(cache.len(), 1);

        let mut expired = ResponseCache::new(1);
        expired.set(key, Json::str("данные"));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(expired.get(key).is_none());
        assert_eq!(expired.stats().get("ttlMs").and_then(Json::as_i64), Some(1));

        let mut disabled = ResponseCache::disabled();
        disabled.set(key, Json::str("данные"));
        assert!(disabled.get(key).is_none());
    }

    #[test]
    fn history_store_dedupes_by_date() {
        let path = temp_path("history.json");
        let mut store = HistoryStore::load(&path);
        let base = Snapshot {
            date: "2026-10-12".to_string(),
            subject_id: None,
            my_place: Some(5),
            my_average: Some(4.4),
            class_average: Some(4.0),
            total: 26,
            saved_at: Some(1),
        };
        assert!(store.append(base.clone()));
        assert!(!store.append(base.clone()));
        let mut moved = base.clone();
        moved.my_place = Some(3);
        assert!(store.append(moved));
        store.save().expect("сохранение");
        let loaded = HistoryStore::load(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.snapshots[0].my_place, Some(3));
        let _ = fs::remove_file(&path);
    }
}
