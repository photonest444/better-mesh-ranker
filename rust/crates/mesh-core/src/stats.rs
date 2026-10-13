//! Статистика и цвета оценок — точный порт `shared/core/lib/stats.js`.
//!
//! Все функции возвращают `Option<f64>` там, где JS возвращает `null`:
//! так пустая выборка не превращается в `NaN` и не «протекает» в интерфейс.

use crate::json::Json;
use crate::util;

/// Среднее арифметическое (пустая выборка → `None`).
pub fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sum = 0.0;
    for value in values {
        sum += *value;
    }
    Some(sum / values.len() as f64)
}

pub fn sum(values: &[f64]) -> f64 {
    let mut total = 0.0;
    for value in values {
        total += *value;
    }
    total
}

/// Медиана: для чётного количества — среднее двух центральных значений.
pub fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted: Vec<f64> = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        Some(sorted[mid])
    } else {
        Some((sorted[mid - 1] + sorted[mid]) / 2.0)
    }
}

pub fn min(values: &[f64]) -> Option<f64> {
    let mut result: Option<f64> = None;
    for value in values {
        if !value.is_finite() {
            continue;
        }
        result = Some(match result {
            Some(current) if current <= *value => current,
            _ => *value,
        });
    }
    result
}

pub fn max(values: &[f64]) -> Option<f64> {
    let mut result: Option<f64> = None;
    for value in values {
        if !value.is_finite() {
            continue;
        }
        result = Some(match result {
            Some(current) if current >= *value => current,
            _ => *value,
        });
    }
    result
}

/// Выборочное стандартное отклонение (n-1), как в JS-ядре.
pub fn std_dev(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    let m = mean(values)?;
    let mut acc = 0.0;
    for value in values {
        acc += (value - m) * (value - m);
    }
    Some((acc / (values.len() as f64 - 1.0)).sqrt())
}

/// Квантиль (0..1) методом линейной интерполяции.
pub fn percentile(values: &[f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted: Vec<f64> = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pos = util::clamp(q, 0.0, 1.0) * (sorted.len() as f64 - 1.0);
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        return Some(sorted[lo]);
    }
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64))
}

/// Корзина гистограммы.
#[derive(Clone, Debug, PartialEq)]
pub struct Bucket {
    pub from: f64,
    pub to: f64,
    pub label: String,
    pub count: usize,
}

impl Bucket {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("from", Json::Num(self.from)),
            ("to", Json::Num(self.to)),
            ("label", Json::Str(self.label.clone())),
            ("count", Json::Num(self.count as f64)),
        ])
    }
}

/// Гистограмма по диапазону (для средних баллов: 2.0 … 5.0 шагом 0.5).
///
/// Логика корзин повторяет JS: последняя корзина включает правую границу,
/// остальные — «левая включительно, правая исключительно».
pub fn histogram(values: &[f64], from: f64, to: f64, step: f64) -> Vec<Bucket> {
    let mut buckets: Vec<Bucket> = Vec::new();
    if step <= 0.0 {
        return buckets;
    }
    let lo = from;
    let hi = to;
    let mut start = hi - step;
    let mut guard = 0;
    while start >= lo - 1e-9 && guard < 10_000 {
        guard += 1;
        let upper = if start + step < hi { start + step } else { hi };
        let is_top = upper >= hi - 1e-9;
        let mut count = 0usize;
        for value in values {
            if *value < start - 1e-9 {
                continue;
            }
            let inside = if is_top {
                *value <= upper + 1e-9
            } else {
                *value < upper - 1e-9
            };
            if inside {
                count += 1;
            }
        }
        buckets.push(Bucket {
            from: util::round(start, 2),
            to: util::round(upper, 2),
            label: format!("{}–{}", util::round(start, 1), util::round(upper, 1)),
            count,
        });
        start -= step;
    }
    buckets
}

/// Место значения в списке (1 — лучшее, равные значения делят место).
pub fn place_of(values: &[f64], value: Option<f64>) -> Option<i64> {
    let target = value?;
    if values.is_empty() {
        return None;
    }
    let mut better = 0i64;
    for item in values {
        if *item > target + 1e-9 {
            better += 1;
        }
    }
    Some(better + 1)
}

/// Цвет оценки: 5 — зелёный, 4 — жёлтый, 3 — оранжевый, ниже — красный.
pub fn grade_color(mark: Option<f64>) -> &'static str {
    match mark {
        Some(value) if value.is_finite() => {
            let rounded = value.round() as i64;
            if rounded >= 5 {
                "green"
            } else if rounded == 4 {
                "yellow"
            } else if rounded == 3 {
                "orange"
            } else {
                "red"
            }
        }
        _ => "none",
    }
}

/// Цвет по месту в классе.
pub fn place_color(place: Option<i64>, total: usize) -> &'static str {
    let (place, total) = match (place, total) {
        (Some(place), total) if place > 0 && total > 0 => (place, total),
        _ => return "none",
    };
    let share = place as f64 / total as f64;
    if share <= 0.15 {
        "green"
    } else if share <= 0.4 {
        "yellow"
    } else if share <= 0.7 {
        "orange"
    } else {
        "red"
    }
}

/// Направление изменения: 1 — рост, -1 — падение, 0 — без изменений.
pub fn trend_direction(current: Option<f64>, previous: Option<f64>, epsilon: f64) -> i32 {
    let (current, previous) = match (current, previous) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => return 0,
    };
    let eps = if epsilon < 0.0 { 0.005 } else { epsilon };
    if current - previous > eps {
        1
    } else if previous - current > eps {
        -1
    } else {
        0
    }
}

/// Сводка по набору чисел (карточки «средний балл класса» и т.п.).
pub fn describe(values: &[f64]) -> Json {
    Json::object(vec![
        ("count", Json::Num(values.len() as f64)),
        ("mean", Json::num(util::round_opt(mean(values), 2))),
        ("median", Json::num(util::round_opt(median(values), 2))),
        ("min", Json::num(min(values))),
        ("max", Json::num(max(values))),
        ("stdDev", Json::num(util::round_opt(std_dev(values), 2))),
        ("p25", Json::num(util::round_opt(percentile(values, 0.25), 2))),
        ("p75", Json::num(util::round_opt(percentile(values, 0.75), 2))),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn central_tendency() {
        assert_eq!(mean(&[5.0, 4.0, 3.0]), Some(4.0));
        assert_eq!(median(&[5.0, 3.0, 4.0, 4.0]), Some(4.0));
        assert_eq!(median(&[1.0, 2.0]), Some(1.5));
        assert_eq!(mean(&[]), None);
        assert_eq!(min(&[4.0, 3.5, 5.0]), Some(3.5));
        assert_eq!(max(&[4.0, 3.5, 5.0]), Some(5.0));
    }

    #[test]
    fn percentiles_and_deviation() {
        assert!((percentile(&[1.0, 2.0, 3.0, 4.0], 0.5).unwrap() - 2.5).abs() < 1e-9);
        let deviation = std_dev(&[4.0, 4.0, 4.0]).unwrap();
        assert!(deviation.abs() < 1e-9);
    }

    #[test]
    fn histogram_counts_all_values() {
        let values = vec![5.0, 4.5, 4.0, 3.5, 4.75];
        let buckets = histogram(&values, 2.0, 5.0, 0.5);
        let total: usize = buckets.iter().map(|bucket| bucket.count).sum();
        assert_eq!(total, values.len());
        assert_eq!(buckets[0].label, "4.5–5");
        assert_eq!(buckets[0].count, 3); // 5.0, 4.75 и 4.5 (верхняя корзина включает границу)
    }

    #[test]
    fn colors_and_places() {
        assert_eq!(grade_color(Some(4.6)), "green");
        assert_eq!(grade_color(Some(4.4)), "yellow");
        assert_eq!(grade_color(Some(3.4)), "orange");
        assert_eq!(grade_color(Some(2.4)), "red");
        assert_eq!(grade_color(None), "none");
        assert_eq!(place_of(&[5.0, 4.0, 4.0, 3.0], Some(4.0)), Some(2));
        assert_eq!(place_color(Some(1), 26), "green");
        assert_eq!(place_color(Some(26), 26), "red");
        assert_eq!(trend_direction(Some(4.6), Some(4.4), 0.005), 1);
        assert_eq!(trend_direction(Some(4.0), Some(4.0), 0.005), 0);
    }
}
