//! Даты, числа и мелкие утилиты — без внешних зависимостей и без часового пояса
//! (МЭШ работает с «календарными» датами `YYYY-MM-DD`, поэтому всё считается в UTC-днях).

use std::time::{SystemTime, UNIX_EPOCH};

// --------------------------------------------------------------- время/даты --

/// Текущее время в миллисекундах эпохи (как `Date.now()` в JS).
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

fn pad2(value: i64) -> String {
    if value < 10 {
        format!("0{}", value)
    } else {
        format!("{}", value)
    }
}

/// Дни от эпохи для календарной даты (алгоритм Говарда Хиннанта, `days_from_civil`).
pub fn epoch_days_from_iso(iso: &str) -> Option<i64> {
    let (year, month, day) = parse_iso_parts(iso)?;
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((month as i64) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + (day as i64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Обратное преобразование: дни от эпохи → `YYYY-MM-DD`.
pub fn iso_from_epoch_days(days: i64) -> String {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{}-{}-{}", year, pad2(month), pad2(day))
}

/// Сегодняшняя дата в формате МЭШ.
pub fn today_iso() -> String {
    let days = now_ms() / 86_400_000;
    iso_from_epoch_days(days)
}

/// Разбор `YYYY-MM-DD` (лишний «хвост» вида `2026-10-12 10:00:00` игнорируется).
pub fn parse_iso_parts(iso: &str) -> Option<(i64, u32, u32)> {
    let bytes = iso.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: u32 = iso.get(5..7)?.parse().ok()?;
    let day: u32 = iso.get(8..10)?.parse().ok()?;
    if bytes[4] != b'-' || bytes[7] != b'-' || month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    Some((year, month, day))
}

/// Приведение значения к ISO-дате — как `util.toIso` в JS (понимает `dd.mm.yyyy`,
/// строки времени, мусор → сегодняшняя дата).
pub fn to_iso(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return today_iso();
    }
    if parse_iso_parts(trimmed).is_some() {
        return trimmed[..10].to_string();
    }
    // 12.10.2026
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 10 && bytes[2] == b'.' && bytes[5] == b'.' {
        if let (Ok(day), Ok(month), Ok(year)) = (
            trimmed[0..2].parse::<u32>(),
            trimmed[3..5].parse::<u32>(),
            trimmed[6..10].parse::<i64>(),
        ) {
            return format!("{}-{}-{}", year, pad2(month as i64), pad2(day as i64));
        }
    }
    today_iso()
}

pub fn add_days(iso: &str, days: i64) -> String {
    match epoch_days_from_iso(&to_iso(iso)) {
        Some(base) => iso_from_epoch_days(base + days),
        None => today_iso(),
    }
}

pub fn add_months(iso: &str, months: i64) -> String {
    let parts = match parse_iso_parts(&to_iso(iso)) {
        Some(value) => value,
        None => return today_iso(),
    };
    let (year, month, day) = parts;
    let total = (year * 12 + (month as i64 - 1)) + months;
    let new_year = total.div_euclid(12);
    let new_month = (total.rem_euclid(12) + 1) as u32;
    let last_day = days_in_month(new_year, new_month);
    let new_day = if day > last_day { last_day } else { day };
    format!("{}-{}-{}", new_year, pad2(new_month as i64), pad2(new_day as i64))
}

pub fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            if leap {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

pub fn days_between(from_iso: &str, to_iso_str: &str) -> i64 {
    let a = epoch_days_from_iso(&to_iso(from_iso)).unwrap_or(0);
    let b = epoch_days_from_iso(&to_iso(to_iso_str)).unwrap_or(0);
    b - a
}

/// Индекс дня недели: 0 — понедельник … 6 — воскресенье.
pub fn weekday_index(iso: &str) -> usize {
    let days = epoch_days_from_iso(&to_iso(iso)).unwrap_or(0);
    ((days + 3).rem_euclid(7)) as usize
}

/// Первое сентября учебного года для даты.
pub fn school_year_start(iso: &str) -> String {
    let (year, month, _) = match parse_iso_parts(&to_iso(iso)) {
        Some(parts) => parts,
        None => return today_iso(),
    };
    if month >= 8 {
        format!("{}-09-01", year)
    } else {
        format!("{}-09-01", year - 1)
    }
}

/// Все даты диапазона включительно (с ограничением, чтобы не утечь в бесконечность).
pub fn each_day(from_iso: &str, to_iso_str: &str, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let from = to_iso(from_iso);
    let to = to_iso(to_iso_str);
    let total = days_between(&from, &to);
    if total < 0 {
        return out;
    }
    let max = if limit == 0 { 400 } else { limit };
    let mut index: i64 = 0;
    while index <= total && out.len() < max {
        out.push(add_days(&from, index));
        index += 1;
    }
    out
}

// -------------------------------------------------------------- мелочи/числа --

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Округление как в JS-ядре: `Math.round((value + EPSILON) * k) / k`.
pub fn round(value: f64, digits: u32) -> f64 {
    let k = 10f64.powi(digits as i32);
    let scaled = (value + f64::EPSILON) * k;
    scaled.round() / k
}

/// Округление `Option<f64>` — `None` остаётся `None` (в JS это `null`).
pub fn round_opt(value: Option<f64>, digits: u32) -> Option<f64> {
    match value {
        Some(n) if n.is_finite() => Some(round(n, digits)),
        _ => None,
    }
}

/// Поиск без учёта регистра (замена регулярных выражений для простых случаев).
pub fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    let hay = haystack.to_lowercase();
    let pattern = needle.to_lowercase();
    hay.find(&pattern)
}

/// Первые `limit` символов строки (по Unicode, а не по байтам).
pub fn chars_take(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Русские склонения: `plural_ru(5, "ученик", "ученика", "учеников")` → «учеников».
pub fn plural_ru(n: i64, one: &str, few: &str, many: &str) -> String {
    let abs = n.abs() % 100;
    let last = abs % 10;
    if (11..20).contains(&abs) {
        return many.to_string();
    }
    if last == 1 {
        return one.to_string();
    }
    if (2..=4).contains(&last) {
        return few.to_string();
    }
    many.to_string()
}

/// Декодирование `%XX` (как `decodeURIComponent`, без превращения «+» в пробел).
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = hex_value(bytes[index + 1]);
            let lo = hex_value(bytes[index + 2]);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(hi * 16 + lo);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Уникальные элементы с сохранением порядка.
pub fn uniq(mut items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

/// Кодирование значения для query-строки (как `encodeURIComponent`).
pub fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        let allowed = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if allowed {
            out.push(ch);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_roundtrip() {
        assert_eq!(epoch_days_from_iso("1970-01-01"), Some(0));
        assert_eq!(iso_from_epoch_days(0), "1970-01-01");
        assert_eq!(iso_from_epoch_days(20301), "2025-08-01");
        assert_eq!(add_days("2026-10-12", -7), "2026-10-05");
        assert_eq!(add_days("2026-09-01", -1), "2026-08-31");
        assert_eq!(days_between("2026-09-01", "2026-10-12"), 41);
    }

    #[test]
    fn iso_parsing_is_tolerant() {
        assert_eq!(to_iso("2026-10-05 12:00:00"), "2026-10-05");
        assert_eq!(to_iso("05.10.2026"), "2026-10-05");
        assert_eq!(to_iso(""), today_iso());
    }

    #[test]
    fn weekdays_and_school_year() {
        // 2026-10-12 — понедельник
        assert_eq!(weekday_index("2026-10-12"), 0);
        assert_eq!(weekday_index("2026-10-18"), 6);
        assert_eq!(school_year_start("2026-10-12"), "2026-09-01");
        assert_eq!(school_year_start("2026-03-12"), "2025-09-01");
    }

    #[test]
    fn helpers() {
        assert_eq!(plural_ru(5, "ученик", "ученика", "учеников"), "учеников");
        assert_eq!(plural_ru(2, "ученик", "ученика", "учеников"), "ученика");
        assert_eq!(plural_ru(1, "урок", "урока", "уроков"), "урок");
        assert_eq!(round(4.6666, 2), 4.67);
        assert_eq!(percent_decode("%D0%9C%D0%AD%D0%A8"), "МЭШ");
        assert_eq!(url_encode("Алгебра 7 «Б»"), "%D0%90%D0%BB%D0%B3%D0%B5%D0%B1%D1%80%D0%B0%207%20%C2%AB%D0%91%C2%BB");
        assert_eq!(find_ci("Рейтинг класса", "класс"), Some(8));
    }

    #[test]
    fn each_day_is_bounded() {
        assert_eq!(each_day("2026-10-01", "2026-10-03", 10).len(), 3);
        assert_eq!(each_day("2026-10-03", "2026-10-01", 10).len(), 0);
        assert_eq!(each_day("2026-01-01", "2026-12-31", 5).len(), 5);
    }
}
