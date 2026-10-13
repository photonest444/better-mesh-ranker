//! Разбор аргументов командной строки без внешних крейтов.
//!
//! Поддерживаются формы `--name value`, `--name=value` и флаги-переключатели.
//! Список «булевых» флагов известен заранее — иначе нельзя отличить
//! `--json rank` (флаг + команда) от `--date 2026-10-12` (флаг + значение).

/// Флаги без значения.
pub const BOOLEAN_FLAGS: [&str; 10] = [
    "json",
    "csv",
    "no-color",
    "color",
    "quiet",
    "demo",
    "help",
    "all",
    "no-cache",
    "verbose",
];

pub struct Args {
    items: Vec<String>,
}

impl Args {
    pub fn parse(items: Vec<String>) -> Args {
        Args { items }
    }

    pub fn is_boolean(name: &str) -> bool {
        BOOLEAN_FLAGS.contains(&name)
    }

    /// Первый позиционный аргумент — команда.
    pub fn command(&self) -> String {
        self.positional().first().cloned().unwrap_or_default()
    }

    /// Второй позиционный аргумент (подкоманда, напр. `history add`).
    pub fn subcommand(&self) -> Option<String> {
        self.positional().get(1).cloned()
    }

    pub fn positional(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut skip_next = false;
        for item in &self.items {
            if skip_next {
                skip_next = false;
                continue;
            }
            if let Some(rest) = item.strip_prefix("--") {
                let name = rest.split('=').next().unwrap_or("");
                if !rest.contains('=') && !Args::is_boolean(name) {
                    skip_next = true;
                }
                continue;
            }
            out.push(item.clone());
        }
        out
    }

    pub fn has(&self, name: &str) -> bool {
        let flag = format!("--{}", name);
        self.items
            .iter()
            .any(|item| item == &flag || item.starts_with(&format!("{}=", flag)))
    }

    pub fn value(&self, name: &str) -> Option<String> {
        let flag = format!("--{}", name);
        let mut index = 0;
        while index < self.items.len() {
            let item = &self.items[index];
            if item == &flag {
                if Args::is_boolean(name) {
                    return None;
                }
                if let Some(next) = self.items.get(index + 1) {
                    if !next.starts_with("--") {
                        return Some(next.clone());
                    }
                }
                return None;
            }
            if let Some(rest) = item.strip_prefix(&format!("{}=", flag)) {
                return Some(rest.to_string());
            }
            index += 1;
        }
        None
    }

    pub fn values(&self, name: &str) -> Vec<String> {
        let flag = format!("--{}", name);
        let mut out: Vec<String> = Vec::new();
        let mut index = 0;
        while index < self.items.len() {
            let item = &self.items[index];
            if item == &flag {
                if !Args::is_boolean(name) {
                    if let Some(next) = self.items.get(index + 1) {
                        if !next.starts_with("--") {
                            out.push(next.clone());
                            index += 1;
                        }
                    }
                }
            } else if let Some(rest) = item.strip_prefix(&format!("{}=", flag)) {
                out.push(rest.to_string());
            }
            index += 1;
        }
        out
    }

    pub fn number(&self, name: &str) -> Option<i64> {
        self.value(name).and_then(|value| value.trim().parse::<i64>().ok())
    }

    pub fn float(&self, name: &str) -> Option<f64> {
        self.value(name)
            .and_then(|value| value.trim().replace(',', ".").parse::<f64>().ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Args {
        Args::parse(list.iter().map(|item| item.to_string()).collect())
    }

    #[test]
    fn commands_and_flags() {
        let parsed = args(&["rank", "--date", "2026-10-12", "--json"]);
        assert_eq!(parsed.command(), "rank");
        assert_eq!(parsed.value("date").as_deref(), Some("2026-10-12"));
        assert!(parsed.has("json"));
        assert!(!parsed.has("csv"));
    }

    #[test]
    fn boolean_flags_do_not_eat_the_command() {
        let parsed = args(&["--json", "rank", "--top", "5"]);
        assert_eq!(parsed.command(), "rank");
        assert_eq!(parsed.number("top"), Some(5));
    }

    #[test]
    fn equals_form_and_repeats() {
        let parsed = args(&["rank", "--subject=1", "--subject", "2", "--top", "5"]);
        assert_eq!(parsed.values("subject"), vec!["1".to_string(), "2".to_string()]);
        assert_eq!(parsed.number("top"), Some(5));
        assert_eq!(parsed.float("target"), None);
    }

    #[test]
    fn subcommands() {
        let parsed = args(&["history", "add", "--date", "2026-10-12"]);
        assert_eq!(parsed.command(), "history");
        assert_eq!(parsed.subcommand().as_deref(), Some("add"));
    }
}
