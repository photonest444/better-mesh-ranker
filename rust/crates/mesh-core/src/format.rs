//! Форматирование значений, CSV и текстовые таблицы.
//!
//! Повторяет `shared/core/lib/format.js`, чтобы CSV из нативного CLI
//! открывался в Excel так же, как из Electron/Android-версии
//! (BOM + разделитель «;»).

use crate::json::Json;
use crate::util;

pub const MONTHS_GENITIVE: [&str; 12] = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
];

pub const MONTHS_NOMINATIVE: [&str; 12] = [
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь",
];

pub const WEEKDAYS_FULL: [&str; 7] = [
    "понедельник",
    "вторник",
    "среда",
    "четверг",
    "пятница",
    "суббота",
    "воскресенье",
];

pub const WEEKDAYS_SHORT: [&str; 7] = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/// «4.67» — или «—», если оценки нет.
pub fn mark(value: Option<f64>, digits: usize) -> String {
    match value {
        Some(n) if n.is_finite() => format!("{:.*}", digits, n),
        _ => "—".to_string(),
    }
}

/// «4,5» — короткая запись с запятой (как в интерфейсе).
pub fn mark_short(value: Option<f64>) -> String {
    match value {
        Some(n) if n.is_finite() => format!("{}", util::round(n, 2)).replace('.', ","),
        _ => "—".to_string(),
    }
}

/// «+0.25» / «-0.10» — как `format.delta`.
pub fn delta(current: Option<f64>, previous: Option<f64>, digits: usize) -> String {
    match (current, previous) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => {
            let diff = a - b;
            let sign = if diff > 0.0 { "+" } else { "" };
            format!("{}{:.*}", sign, digits, diff)
        }
        _ => "—".to_string(),
    }
}

pub fn trend_arrow(direction: i32) -> &'static str {
    if direction > 0 {
        "▲"
    } else if direction < 0 {
        "▼"
    } else {
        "="
    }
}

pub fn percent(value: Option<f64>, digits: usize) -> String {
    match value {
        Some(n) if n.is_finite() => format!("{:.*}%", digits, n * 100.0),
        _ => "—".to_string(),
    }
}

/// «12 октября 2026» (можно добавить день недели).
pub fn date_ru(iso: &str, with_weekday: bool) -> String {
    let normalized = util::to_iso(iso);
    let parts = util::parse_iso_parts(&normalized).unwrap_or((2026, 1, 1));
    let (year, month, day) = parts;
    let text = format!(
        "{} {} {}",
        day,
        MONTHS_GENITIVE[(month as usize - 1).min(11)],
        year
    );
    if with_weekday {
        format!("{}, {}", weekday_full(&normalized), text)
    } else {
        text
    }
}

/// «12.10.2026».
pub fn date_short(iso: &str) -> String {
    let normalized = util::to_iso(iso);
    format!("{}.{}.{}", &normalized[8..10], &normalized[5..7], &normalized[0..4])
}

/// «12.10».
pub fn date_day_month(iso: &str) -> String {
    let normalized = util::to_iso(iso);
    format!("{}.{}", &normalized[8..10], &normalized[5..7])
}

pub fn weekday_short(iso: &str) -> &'static str {
    WEEKDAYS_SHORT[util::weekday_index(iso)]
}

pub fn weekday_full(iso: &str) -> &'static str {
    WEEKDAYS_FULL[util::weekday_index(iso)]
}

pub fn month_name(index: usize) -> &'static str {
    MONTHS_NOMINATIVE[index.min(11)]
}

/// «01.09 — 12.10.2026».
pub fn date_range_text(from_iso: &str, to_iso_str: &str) -> String {
    let from = util::to_iso(from_iso);
    let to = util::to_iso(to_iso_str);
    if from[0..4] == to[0..4] {
        if from[0..7] == to[0..7] {
            return format!("{} — {}", &from[8..10], date_short(&to));
        }
        return format!("{}.{} — {}", &from[8..10], &from[5..7], date_short(&to));
    }
    format!("{} — {}", date_short(&from), date_short(&to))
}

/// «5 минут назад».
pub fn relative_time(timestamp_ms: i64) -> String {
    if timestamp_ms <= 0 {
        return "никогда".to_string();
    }
    let diff = util::now_ms() - timestamp_ms;
    let minutes = (diff as f64 / 60_000.0).round() as i64;
    if minutes < 1 {
        return "только что".to_string();
    }
    if minutes < 60 {
        return format!("{} {} назад", minutes, util::plural_ru(minutes, "минуту", "минуты", "минут"));
    }
    let hours = (minutes as f64 / 60.0).round() as i64;
    if hours < 24 {
        return format!("{} {} назад", hours, util::plural_ru(hours, "час", "часа", "часов"));
    }
    let days = (hours as f64 / 24.0).round() as i64;
    format!("{} {} назад", days, util::plural_ru(days, "день", "дня", "дней"))
}

pub fn students_count(count: i64) -> String {
    format!("{} {}", count, util::plural_ru(count, "ученик", "ученика", "учеников"))
}

pub fn marks_count(count: i64) -> String {
    format!("{} {}", count, util::plural_ru(count, "оценка", "оценки", "оценок"))
}

pub fn lessons_count(count: i64) -> String {
    format!("{} {}", count, util::plural_ru(count, "урок", "урока", "уроков"))
}

/// Обрезка длинного текста для ячейки таблицы.
pub fn truncate(text: &str, max: usize) -> String {
    let limit = if max == 0 { 120 } else { max };
    let squeezed = text.split_whitespace().collect::<Vec<&str>>().join(" ");
    let mut chars = squeezed.chars();
    let head: String = chars.by_ref().take(limit.saturating_sub(1)).collect();
    if chars.next().is_some() {
        format!("{}…", head)
    } else {
        squeezed
    }
}

// ------------------------------------------------------------------ таблицы --

/// Формат значения колонки при выводе в CSV/CLI.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColumnFormat {
    Raw,
    Mark,
    Delta,
    Date,
    DateRu,
    Trend,
    Bool,
    Place,
}

/// Описание колонки: путь в объекте + заголовок + формат.
#[derive(Clone, Debug)]
pub struct Column {
    pub key: String,
    pub title: String,
    pub format: ColumnFormat,
}

impl Column {
    pub fn new(key: &str, title: &str, format: ColumnFormat) -> Column {
        Column { key: key.to_string(), title: title.to_string(), format: format }
    }

    /// Значение колонки для строки (с учётом формата).
    pub fn value(&self, row: &Json) -> String {
        let raw = row.get_path(&self.key);
        match self.format {
            ColumnFormat::Raw => match raw {
                Some(value) => value.text(),
                None => String::new(),
            },
            ColumnFormat::Mark => match raw.and_then(Json::as_f64) {
                Some(n) => format!("{:.2}", n),
                None => "—".to_string(),
            },
            ColumnFormat::Delta => {
                let current = raw.and_then(Json::as_f64);
                let previous = row.get_path(&format!("previous{}", capitalize(&self.key))).and_then(Json::as_f64);
                match (current, previous) {
                    (Some(a), Some(b)) => delta(Some(a), Some(b), 2),
                    (Some(a), None) => format!("{:.2}", a),
                    _ => "—".to_string(),
                }
            }
            ColumnFormat::Date => match raw {
                Some(value) if !value.is_blank() => date_short(&value.text()),
                _ => "—".to_string(),
            },
            ColumnFormat::DateRu => match raw {
                Some(value) if !value.is_blank() => date_ru(&value.text(), false),
                _ => "—".to_string(),
            },
            ColumnFormat::Trend => {
                let direction = raw.and_then(Json::as_i64).unwrap_or(0);
                trend_arrow(direction as i32).to_string()
            }
            ColumnFormat::Bool => match raw.and_then(Json::as_bool) {
                Some(true) => "✓".to_string(),
                _ => "—".to_string(),
            },
            ColumnFormat::Place => match raw.and_then(Json::as_i64) {
                Some(place) if place > 0 => format!("#{}", place),
                _ => "—".to_string(),
            },
        }
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Экранирование ячейки CSV (повторяет `format.csvCell`).
pub fn csv_cell(value: &str, sep: char) -> String {
    let cleaned = value.replace("\r\n", " ").replace('\n', " ").replace('\r', " ");
    let has_quote = cleaned.contains('"');
    let mut text = if has_quote { cleaned.replace('"', "\"\"") } else { cleaned.clone() };
    let needs_quotes = text.contains(sep)
        || text.contains(',')
        || text.contains('"')
        || cleaned.starts_with(' ')
        || cleaned.ends_with(' ');
    if needs_quotes {
        text = format!("\"{}\"", text);
    }
    text
}

/// CSV с BOM и разделителем «;» — как в JS-ядре.
pub fn to_csv(rows: &[Json], columns: &[Column], title: Option<&str>, sep: char, bom: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(text) = title {
        if !text.is_empty() {
            lines.push(csv_cell(text, sep));
        }
    }
    let head: Vec<String> = columns.iter().map(|c| csv_cell(&c.title, sep)).collect();
    lines.push(head.join(&sep.to_string()));
    for row in rows {
        let cells: Vec<String> = columns.iter().map(|c| csv_cell(&c.value(row), sep)).collect();
        lines.push(cells.join(&sep.to_string()));
    }
    let body = lines.join("\r\n");
    if bom {
        format!("\u{feff}{}", body)
    } else {
        body
    }
}

/// Таблица для терминала (для копирования в чат/документ).
pub fn to_text_table(rows: &[Json], columns: &[Column], max_width: usize) -> String {
    let cap = if max_width == 0 { 40 } else { max_width };
    let mut widths: Vec<usize> = Vec::with_capacity(columns.len());
    for column in columns {
        let mut width = column.title.chars().count();
        for row in rows {
            let length = column.value(row).chars().count();
            if length > width {
                width = length;
            }
        }
        widths.push(width.min(cap));
    }
    let fit = |text: &str, width: usize| -> String {
        let count = text.chars().count();
        if count > width {
            let head: String = text.chars().take(width.saturating_sub(1)).collect();
            return format!("{}…", head);
        }
        let mut out = text.to_string();
        while out.chars().count() < width {
            out.push(' ');
        }
        out.push(' ');
        out
    };
    let mut lines: Vec<String> = Vec::new();
    let head: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(index, column)| fit(&column.title, widths[index]))
        .collect();
    lines.push(head.join("| ").trim_end().to_string());
    let separators: Vec<String> = widths.iter().map(|width| "-".repeat(width + 1)).collect();
    lines.push(separators.join("+").trim_end().to_string());
    for row in rows {
        let cells: Vec<String> = columns
            .iter()
            .enumerate()
            .map(|(index, column)| fit(&column.value(row), widths[index]))
            .collect();
        lines.push(cells.join("| ").trim_end().to_string());
    }
    lines.join("\n")
}

/// Имя файла экспорта: `mesh-rating-2026-10-12.csv`.
pub fn export_file_name(kind: &str, iso: &str, extension: &str) -> String {
    let stamp = util::to_iso(iso);
    let mut parts: Vec<String> = vec!["mesh".to_string()];
    if !kind.is_empty() {
        parts.push(kind.to_string());
    }
    parts.push(stamp);
    format!("{}.{}", parts.join("-"), if extension.is_empty() { "csv" } else { extension })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_and_deltas() {
        assert_eq!(mark(Some(4.6666), 2), "4.67");
        assert_eq!(mark(None, 2), "—");
        assert_eq!(mark_short(Some(4.5)), "4,5");
        assert_eq!(delta(Some(4.75), Some(4.5), 2), "+0.25");
        assert_eq!(delta(Some(4.5), Some(4.5), 2), "0.00");
        assert_eq!(trend_arrow(-1), "▼");
    }

    #[test]
    fn dates_in_russian() {
        assert_eq!(date_short("2026-10-12"), "12.10.2026");
        assert_eq!(date_ru("2026-10-12", false), "12 октября 2026");
        assert_eq!(date_ru("2026-10-12", true), "понедельник, 12 октября 2026");
        assert_eq!(weekday_short("2026-10-12"), "пн");
        assert_eq!(date_range_text("2026-09-01", "2026-10-12"), "01.09 — 12.10.2026");
    }

    #[test]
    fn csv_quoting() {
        assert_eq!(csv_cell("Иванов; Иван", ';'), "\"Иванов; Иван\"");
        assert_eq!(csv_cell("Петров, Пётр", ';'), "\"Петров, Пётр\"");
        assert_eq!(csv_cell("просто", ';'), "просто");
        assert_eq!(csv_cell("с \"кавычками\"", ';'), "\"с \"\"кавычками\"\"\"");
    }

    #[test]
    fn csv_has_bom_and_crlf() {
        let rows = vec![Json::object(vec![
            ("name", Json::str("Иванов Иван")),
            ("average", Json::Num(4.75)),
        ])];
        let columns = vec![
            Column::new("name", "Ученик", ColumnFormat::Raw),
            Column::new("average", "Средний балл", ColumnFormat::Mark),
        ];
        let csv = to_csv(&rows, &columns, Some("Рейтинг класса"), ';', true);
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("Рейтинг класса"));
        assert!(csv.contains("Иванов Иван;4.75"));
        assert!(csv.contains("\r\n"));
    }

    #[test]
    fn text_table_is_aligned() {
        let rows = vec![
            Json::object(vec![("place", Json::Num(1.0)), ("name", Json::str("Аня"))]),
            Json::object(vec![("place", Json::Num(2.0)), ("name", Json::str("Борис"))]),
        ];
        let columns = vec![
            Column::new("place", "Место", ColumnFormat::Raw),
            Column::new("name", "Ученик", ColumnFormat::Raw),
        ];
        let text = to_text_table(&rows, &columns, 40);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].contains("Место"));
        assert!(lines[2].contains("| Аня"));
        assert!(lines[2].starts_with("1 "));
    }
}
