//! Аналитика поверх данных МЭШ: динамика места и балла, прогноз до цели,
//! влияние оценок на средний балл и разбор дедлайнов по домашним заданиям.
//!
//! Эти функции есть и в JS-ядре (`shared/core/lib/insights.js`) — shapes
//! специально совпадают, чтобы интерфейс работал с любым движком.

use crate::format;
use crate::json::Json;
use crate::model::{Homework, Mark};
use crate::normalize;
use crate::stats;
use crate::util;

// ----------------------------------------------------------------- динамика --

/// Снимок рейтинга, сохранённый приложением (локальная история).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub date: String,
    pub subject_id: Option<String>,
    pub my_place: Option<i64>,
    pub my_average: Option<f64>,
    pub class_average: Option<f64>,
    pub total: usize,
    pub saved_at: Option<i64>,
}

impl Snapshot {
    pub fn from_json(value: &Json) -> Snapshot {
        let subject = value.get("subjectId").map(Json::text).unwrap_or_default();
        let date = value.get("date").map(Json::text).unwrap_or_default();
        Snapshot {
            date: util::to_iso(&date),
            subject_id: if subject.trim().is_empty() { None } else { Some(subject) },
            my_place: value.get("myPlace").and_then(Json::as_i64),
            my_average: value.get("myAverage").and_then(Json::as_f64),
            class_average: value.get("classAverage").and_then(Json::as_f64),
            total: value.get("total").and_then(Json::as_f64).unwrap_or(0.0) as usize,
            saved_at: value.get("savedAt").and_then(Json::as_i64),
        }
    }

    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("date", Json::str(self.date.clone())),
            ("subjectId", Json::text_or_null(&self.subject_id)),
            ("myPlace", Json::int(self.my_place)),
            ("myAverage", Json::num(self.my_average)),
            ("classAverage", Json::num(self.class_average)),
            ("total", Json::Num(self.total as f64)),
            ("savedAt", Json::int(self.saved_at)),
        ])
    }
}

/// Строит серию «динамика» по сохранённым снимкам.
///
/// `subject_id = None` — только общий рейтинг, `Some(id)` — конкретный предмет.
pub fn history_series(snapshots: &[Snapshot], subject_id: Option<&str>) -> Json {
    let mut selected: Vec<Snapshot> = Vec::new();
    for snapshot in snapshots {
        let matches = match (subject_id, &snapshot.subject_id) {
            (None, None) => true,
            (Some(wanted), Some(current)) => wanted == current.as_str(),
            _ => false,
        };
        if matches {
            selected.push(snapshot.clone());
        }
    }
    selected.sort_by(|a, b| a.date.cmp(&b.date));
    // Оставляем по одному снимку на дату (последний записанный).
    let mut unique: Vec<Snapshot> = Vec::new();
    for snapshot in selected {
        if let Some(last) = unique.last_mut() {
            if last.date == snapshot.date {
                *last = snapshot;
                continue;
            }
        }
        unique.push(snapshot);
    }

    let mut points: Vec<Json> = Vec::with_capacity(unique.len());
    let mut places: Vec<f64> = Vec::new();
    let mut averages: Vec<f64> = Vec::new();
    for snapshot in &unique {
        points.push(Json::object(vec![
            ("date", Json::str(snapshot.date.clone())),
            ("place", Json::int(snapshot.my_place)),
            ("average", Json::num(snapshot.my_average)),
            ("classAverage", Json::num(snapshot.class_average)),
            ("total", Json::Num(snapshot.total as f64)),
        ]));
        if let Some(place) = snapshot.my_place {
            places.push(place as f64);
        }
        if let Some(average) = snapshot.my_average {
            averages.push(average);
        }
    }

    let first = unique.first();
    let last = unique.last();
    let first_place = first.and_then(|snapshot| snapshot.my_place);
    let last_place = last.and_then(|snapshot| snapshot.my_place);
    let first_average = first.and_then(|snapshot| snapshot.my_average);
    let last_average = last.and_then(|snapshot| snapshot.my_average);
    let place_delta = match (first_place, last_place) {
        (Some(from), Some(to)) => Some(from - to), // плюс — поднялся выше
        _ => None,
    };
    let average_delta = match (first_average, last_average) {
        (Some(from), Some(to)) => Some(util::round(to - from, 2)),
        _ => None,
    };
    let best_place = min_i64(&places);
    let worst_place = max_i64(&places);
    let mut best_place_date = String::new();
    let mut worst_place_date = String::new();
    for snapshot in &unique {
        if snapshot.my_place == best_place && best_place_date.is_empty() {
            best_place_date = snapshot.date.clone();
        }
        if snapshot.my_place == worst_place {
            worst_place_date = snapshot.date.clone();
        }
    }

    Json::object(vec![
        ("subjectId", Json::text_or_null(&subject_id.map(|value| value.to_string()))),
        ("count", Json::Num(unique.len() as f64)),
        ("points", Json::Arr(points)),
        ("firstDate", Json::str(first.map(|s| s.date.clone()).unwrap_or_default())),
        ("lastDate", Json::str(last.map(|s| s.date.clone()).unwrap_or_default())),
        ("firstAverage", Json::num(first_average)),
        ("lastAverage", Json::num(last_average)),
        ("averageDelta", Json::num(average_delta)),
        ("firstPlace", Json::int(first_place)),
        ("lastPlace", Json::int(last_place)),
        ("placeDelta", Json::int(place_delta)),
        ("bestPlace", Json::int(best_place)),
        ("bestPlaceDate", Json::str(best_place_date)),
        ("worstPlace", Json::int(worst_place)),
        ("worstPlaceDate", Json::str(worst_place_date)),
        ("trend", Json::Num(trend_of(place_delta, average_delta) as f64)),
        (
            "improved",
            Json::Bool(match (place_delta, average_delta) {
                (Some(delta), _) if delta > 0 => true,
                (Some(0), Some(average)) => average > 0.0,
                _ => false,
            }),
        ),
        ("sparkline", Json::str(sparkline(&averages, false))),
        ("placeSparkline", Json::str(sparkline(&places, true))),
    ])
}

fn trend_of(place_delta: Option<i64>, average_delta: Option<f64>) -> i32 {
    if let Some(delta) = place_delta {
        if delta > 0 {
            return 1;
        }
        if delta < 0 {
            return -1;
        }
    }
    match average_delta {
        Some(delta) if delta > 0.005 => 1,
        Some(delta) if delta < -0.005 => -1,
        _ => 0,
    }
}

fn min_i64(values: &[f64]) -> Option<i64> {
    let mut best: Option<i64> = None;
    for place in values {
        let current = *place as i64;
        best = Some(match best {
            Some(existing) if existing <= current => existing,
            _ => current,
        });
    }
    best
}

fn max_i64(values: &[f64]) -> Option<i64> {
    let mut worst: Option<i64> = None;
    for place in values {
        let current = *place as i64;
        worst = Some(match worst {
            Some(existing) if existing >= current => existing,
            _ => current,
        });
    }
    worst
}

// ------------------------------------------------------------------ прогноз --

/// Прогноз «сколько нужно, чтобы выйти на целевой средний балл».
///
/// `remaining` — сколько работ/оценок ещё ожидается (обычно 1–5).
pub fn forecast(marks: &[Mark], target: f64, remaining: i64) -> Json {
    let mut values: Vec<f64> = Vec::new();
    for mark in marks {
        if let Some(value) = mark.value {
            if value.is_finite() {
                values.push(value);
            }
        }
    }
    let count = values.len();
    let total: f64 = stats::sum(&values);
    let average = stats::mean(&values);
    let weighted = if count > 0 {
        let mut weighted_sum = 0.0;
        let mut weights = 0.0;
        for mark in marks {
            if let Some(value) = mark.value {
                if value.is_finite() {
                    let weight = if mark.weight > 0.0 { mark.weight } else { 1.0 };
                    weighted_sum += value * weight;
                    weights += weight;
                }
            }
        }
        if weights > 0.0 {
            Some(weighted_sum / weights)
        } else {
            None
        }
    } else {
        None
    };

    let remaining = if remaining <= 0 { 1 } else { remaining };
    let current = average.unwrap_or(0.0);
    let gap = target - current;
    let needed_average = if count == 0 {
        // Оценок ещё нет — нужен просто средний балл цели.
        Some(target)
    } else {
        Some((target * (count as f64 + remaining as f64) - total) / remaining as f64)
    };
    let fives_needed = if count == 0 {
        remaining
    } else if target >= 5.0 {
        i64::MAX
    } else {
        let numerator = target * count as f64 - total;
        if numerator <= 0.0 {
            0
        } else {
            (numerator / (5.0 - target)).ceil() as i64
        }
    };
    let max_possible = if count == 0 {
        Some(5.0)
    } else {
        Some((total + 5.0 * remaining as f64) / (count as f64 + remaining as f64))
    };
    let min_possible = if count == 0 {
        Some(2.0)
    } else {
        Some((total + 2.0 * remaining as f64) / (count as f64 + remaining as f64))
    };
    let status = if average.map(|value| value >= target - 1e-9).unwrap_or(false) {
        "done"
    } else if needed_average.map(|value| value <= 5.0 + 1e-9).unwrap_or(false) {
        "achievable"
    } else {
        "unreachable"
    };
    let text = match status {
        "done" => format!(
            "Цель {} уже достигнута: средний балл {}",
            format::mark_short(Some(target)),
            format::mark_short(average)
        ),
        "achievable" => format!(
            "Нужно ещё {} (или среднее {} за {} работ)",
            format::marks_count(fives_needed.min(remaining)),
            format::mark_short(needed_average),
            remaining
        ),
        _ => format!(
            "Даже одни «пятёрки» дадут максимум {} — цель {} пока не достижима",
            format::mark_short(max_possible),
            format::mark_short(Some(target))
        ),
    }
    .to_string();

    Json::object(vec![
        ("count", Json::Num(count as f64)),
        ("withValue", Json::Num(count as f64)),
        ("sum", Json::Num(total)),
        ("average", Json::num(util::round_opt(average, 2))),
        ("weightedAverage", Json::num(util::round_opt(weighted, 2))),
        ("target", Json::Num(target)),
        ("gap", Json::num(util::round_opt(Some(gap), 2))),
        ("remaining", Json::Num(remaining as f64)),
        ("neededAverage", Json::num(util::round_opt(needed_average, 2))),
        ("fivesNeeded", Json::int(if fives_needed == i64::MAX { None } else { Some(fives_needed) })),
        (
            "maxPossible",
            Json::num(util::round_opt(max_possible, 2)),
        ),
        (
            "minPossible",
            Json::num(util::round_opt(min_possible, 2)),
        ),
        ("status", Json::str(status)),
        ("text", Json::str(text)),
    ])
}

/// «А что если?» — как изменится средний балл от набора новых оценок.
pub fn what_if(marks: &[Mark], extra: &[f64]) -> Json {
    let mut values: Vec<f64> = Vec::new();
    for mark in marks {
        if let Some(value) = mark.value {
            if value.is_finite() {
                values.push(value);
            }
        }
    }
    let before = stats::mean(&values);
    let mut after_values = values.clone();
    for value in extra {
        if value.is_finite() {
            after_values.push(*value);
        }
    }
    let after = stats::mean(&after_values);
    Json::object(vec![
        ("before", Json::num(util::round_opt(before, 2))),
        ("after", Json::num(util::round_opt(after, 2))),
        (
            "delta",
            Json::num(util::round_opt(
                match (before, after) {
                    (Some(a), Some(b)) => Some(b - a),
                    _ => None,
                },
                2,
            )),
        ),
        ("count", Json::Num(values.len() as f64)),
        ("added", Json::Arr(extra.iter().map(|value| Json::Num(*value)).collect())),
    ])
}

/// По каким предметам одна «пятёрка» даст наибольший прирост среднего балла.
pub fn subject_impact(marks: &[Mark], limit: usize) -> Json {
    let mut keys: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut sums: Vec<f64> = Vec::new();
    let mut counts: Vec<usize> = Vec::new();

    for mark in marks {
        let value = match mark.value {
            Some(value) if value.is_finite() => value,
            _ => continue,
        };
        let key = if !mark.subject_id.is_empty() {
            mark.subject_id.clone()
        } else {
            mark.subject_name.clone()
        };
        let position = match keys.iter().position(|item| *item == key) {
            Some(index) => index,
            None => {
                keys.push(key);
                names.push(mark.subject_name.clone());
                sums.push(0.0);
                counts.push(0);
                keys.len() - 1
            }
        };
        sums[position] += value;
        counts[position] += 1;
    }

    let total_marks: usize = counts.iter().sum();
    let mut rows: Vec<Json> = Vec::new();
    for index in 0..keys.len() {
        let count = counts[index];
        if count == 0 {
            continue;
        }
        let sum = sums[index];
        let average = sum / count as f64;
        let next_five = (sum + 5.0) / (count as f64 + 1.0);
        rows.push(Json::object(vec![
            ("subjectId", Json::str(keys[index].clone())),
            ("subjectName", Json::str(names[index].clone())),
            ("count", Json::Num(count as f64)),
            ("average", Json::num(util::round_opt(Some(average), 2))),
            (
                "deltaIfFive",
                Json::num(util::round_opt(Some(next_five - average), 2)),
            ),
            (
                "share",
                Json::num(util::round_opt(
                    Some(count as f64 / total_marks.max(1) as f64),
                    3,
                )),
            ),
        ]));
    }
    rows.sort_by(|a, b| {
        let left = a.get("deltaIfFive").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("deltaIfFive").and_then(Json::as_f64).unwrap_or(0.0);
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });
    if limit > 0 && rows.len() > limit {
        rows.truncate(limit);
    }
    Json::Arr(rows)
}

// ------------------------------------------------------------------ дедлайны --

/// Разбор домашних заданий по срокам: просрочено / сегодня / завтра / неделя.
pub fn deadlines(homeworks: &[Homework], reference: &str) -> Json {
    let today = util::to_iso(reference);
    let tomorrow = util::add_days(&today, 1);
    let week_end = util::add_days(&today, 7);

    let mut groups: Vec<(&str, &str, Vec<Json>)> = vec![
        ("overdue", "Просрочено", Vec::new()),
        ("today", "Сегодня", Vec::new()),
        ("tomorrow", "Завтра", Vec::new()),
        ("week", "На неделе", Vec::new()),
        ("later", "Позже", Vec::new()),
        ("no-deadline", "Без срока", Vec::new()),
        ("done", "Выполнено", Vec::new()),
    ];
    let mut undone = 0usize;
    let mut done = 0usize;
    let mut overdue = 0usize;
    // Самое срочное несданное задание (просроченное — самое срочное) и
    // ближайшее из ещё не просроченных: в интерфейсе это две разные подсказки.
    let mut next: Option<Homework> = None;
    let mut next_upcoming: Option<Homework> = None;

    for homework in homeworks {
        if homework.is_done {
            done += 1;
            groups[6].2.push(homework.to_json());
            continue;
        }
        undone += 1;
        let bucket = match &homework.due_date {
            None => 5usize,
            Some(due) => {
                if due.as_str() < today.as_str() {
                    overdue += 1;
                    0
                } else if due.as_str() == today.as_str() {
                    1
                } else if due.as_str() == tomorrow.as_str() {
                    2
                } else if due.as_str() <= week_end.as_str() {
                    3
                } else {
                    4
                }
            }
        };
        if bucket <= 3 {
            let candidate_is_closer = match (&next, &homework.due_date) {
                (None, _) => true,
                (Some(current), Some(due)) => match &current.due_date {
                    Some(current_due) => due < current_due,
                    None => true,
                },
                _ => false,
            };
            if candidate_is_closer {
                next = Some(homework.clone());
            }
            if bucket == 1 || bucket == 2 || bucket == 3 {
                let upcoming_is_closer = match (&next_upcoming, &homework.due_date) {
                    (None, _) => true,
                    (Some(current), Some(due)) => match &current.due_date {
                        Some(current_due) => due < current_due,
                        None => true,
                    },
                    _ => false,
                };
                if upcoming_is_closer {
                    next_upcoming = Some(homework.clone());
                }
            }
        }
        groups[bucket].2.push(homework.to_json());
    }

    let total = homeworks.len();
    let progress = if total == 0 { 0.0 } else { done as f64 / total as f64 };
    let groups_json: Vec<Json> = groups
        .iter()
        .map(|(key, label, items)| {
            Json::object(vec![
                ("key", Json::str(*key)),
                ("label", Json::str(*label)),
                ("count", Json::Num(items.len() as f64)),
                ("items", Json::Arr(items.clone())),
            ])
        })
        .collect();

    // Нагрузка по дням: сколько заданий нужно сдать в каждый из ближайших дней.
    let mut by_day: Vec<Json> = Vec::new();
    for offset in 0..14i64 {
        let date = util::add_days(&today, offset);
        let count = homeworks
            .iter()
            .filter(|homework| homework.due_date.as_deref() == Some(date.as_str()))
            .count();
        by_day.push(Json::object(vec![
            ("date", Json::str(date)),
            ("count", Json::Num(count as f64)),
        ]));
    }

    Json::object(vec![
        ("reference", Json::str(today)),
        ("total", Json::Num(total as f64)),
        ("done", Json::Num(done as f64)),
        ("undone", Json::Num(undone as f64)),
        ("overdue", Json::Num(overdue as f64)),
        ("progress", Json::num(util::round_opt(Some(progress), 3))),
        ("groups", Json::Arr(groups_json)),
        ("byDay", Json::Arr(by_day)),
        (
            "next",
            match next {
                Some(homework) => homework.to_json(),
                None => Json::Null,
            },
        ),
        (
            "nextUpcoming",
            match next_upcoming {
                Some(homework) => homework.to_json(),
                None => Json::Null,
            },
        ),
    ])
}

/// Разбор домашних заданий из «сырого» ответа МЭШ.
pub fn deadlines_from_payload(data: &Json, reference: &str) -> Json {
    let mut homeworks: Vec<Homework> = Vec::new();
    for item in normalize::payload_list(data) {
        homeworks.push(normalize::normalize_homework(&item));
    }
    deadlines(&homeworks, reference)
}

// ---------------------------------------------------------------- спарклайн --

const SPARK_CHARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/// Текстовая мини-диаграмма: `sparkline([4.1, 4.3, 4.5], false)` → «▁▄█».
///
/// `invert = true` используется для мест: меньшее значение — лучше.
pub fn sparkline(values: &[f64], invert: bool) -> String {
    let clean: Vec<f64> = values.iter().copied().filter(|value| value.is_finite()).collect();
    if clean.is_empty() {
        return String::new();
    }
    let min = stats::min(&clean).unwrap_or(0.0);
    let max = stats::max(&clean).unwrap_or(0.0);
    let span = max - min;
    let mut out = String::with_capacity(clean.len());
    for value in &clean {
        let ratio = if span <= 0.0 { 0.5 } else { (*value - min) / span };
        let ratio = if invert { 1.0 - ratio } else { ratio };
        let index = ((ratio * 7.0) as usize).min(7);
        out.push(SPARK_CHARS[index]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshots() -> Vec<Snapshot> {
        vec![
            Snapshot {
                date: "2026-09-01".into(),
                subject_id: None,
                my_place: Some(7),
                my_average: Some(4.2),
                class_average: Some(4.0),
                total: 26,
                saved_at: Some(1),
            },
            Snapshot {
                date: "2026-10-01".into(),
                subject_id: None,
                my_place: Some(5),
                my_average: Some(4.4),
                class_average: Some(4.05),
                total: 26,
                saved_at: Some(2),
            },
            Snapshot {
                date: "2026-10-12".into(),
                subject_id: None,
                my_place: Some(3),
                my_average: Some(4.55),
                class_average: Some(4.02),
                total: 26,
                saved_at: Some(3),
            },
            Snapshot {
                date: "2026-10-12".into(),
                subject_id: Some("1".into()),
                my_place: Some(9),
                my_average: Some(4.1),
                class_average: None,
                total: 26,
                saved_at: Some(4),
            },
        ]
    }

    #[test]
    fn history_tracks_progress() {
        let series = history_series(&snapshots(), None);
        assert_eq!(series.get("count").and_then(Json::as_i64), Some(3));
        assert_eq!(series.get("placeDelta").and_then(Json::as_i64), Some(4));
        assert_eq!(series.get("trend").and_then(Json::as_i64), Some(1));
        assert_eq!(series.get("improved").and_then(Json::as_bool), Some(true));
        assert_eq!(series.get("bestPlace").and_then(Json::as_i64), Some(3));
        assert_eq!(series.get("worstPlace").and_then(Json::as_i64), Some(7));
        let spark = series.get("sparkline").map(Json::text).unwrap_or_default();
        assert_eq!(spark.chars().count(), 3);
        let place_spark = series.get("placeSparkline").map(Json::text).unwrap_or_default();
        assert_eq!(place_spark.chars().count(), 3);
    }

    #[test]
    fn history_is_filtered_by_subject() {
        let series = history_series(&snapshots(), Some("1"));
        assert_eq!(series.get("count").and_then(Json::as_i64), Some(1));
        assert_eq!(series.get("lastPlace").and_then(Json::as_i64), Some(9));
    }

    #[test]
    fn forecast_counts_fives() {
        let source = Json::parse(
            r#"[{"value":5,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-01"},
                {"value":4,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-02"}]"#,
        )
        .expect("json");
        let mut marks: Vec<Mark> = Vec::new();
        if let Some(items) = source.as_arr() {
            for item in items {
                marks.push(normalize::normalize_mark(item));
            }
        }
        // текущий средний 4.5, цель 4.6, осталась 1 работа → нужна «5»
        let plan = forecast(&marks, 4.6, 1);
        assert_eq!(plan.get("average").and_then(Json::as_f64), Some(4.5));
        assert_eq!(plan.get("neededAverage").and_then(Json::as_f64), Some(4.8));
        assert_eq!(plan.get("status").map(Json::text), Some("achievable".to_string()));
        assert_eq!(plan.get("fivesNeeded").and_then(Json::as_i64), Some(1));

        // цель 4.75 при одной оставшейся работе уже недостижима (максимум 4.67)
        let impossible = forecast(&marks, 4.75, 1);
        assert_eq!(impossible.get("status").map(Json::text), Some("unreachable".to_string()));
        assert_eq!(impossible.get("maxPossible").and_then(Json::as_f64), Some(4.67));

        // цель 4.9 при одной оставшейся работе недостижима
        let hard = forecast(&marks, 4.9, 1);
        assert_eq!(hard.get("status").map(Json::text), Some("unreachable".to_string()));

        // цель ниже текущей — уже достигнута
        let done = forecast(&marks, 4.0, 1);
        assert_eq!(done.get("status").map(Json::text), Some("done".to_string()));
    }

    #[test]
    fn what_if_and_impact() {
        let source = Json::parse(
            r#"[{"value":5,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-01"},
                {"value":3,"subject_id":"2","subject_name":"Физика","date":"2026-10-02"}]"#,
        )
        .expect("json");
        let mut marks: Vec<Mark> = Vec::new();
        if let Some(items) = source.as_arr() {
            for item in items {
                marks.push(normalize::normalize_mark(item));
            }
        }
        let simulation = what_if(&marks, &[5.0]);
        assert_eq!(simulation.get("before").and_then(Json::as_f64), Some(4.0));
        assert_eq!(simulation.get("after").and_then(Json::as_f64), Some(4.33));

        let impact = subject_impact(&marks, 10);
        let rows = impact.as_arr().expect("массив");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get("subjectName").map(Json::text), Some("Физика".to_string()));
    }

    #[test]
    fn deadlines_group_by_date() {
        let source = Json::parse(
            r#"[{"homework_id":"h1","subject_name":"История","description":"Параграф 12","date_prepared":"2026-10-10"},
                {"homework_id":"h2","subject_name":"Алгебра","description":"Номера 1–10","date_prepared":"2026-10-13"},
                {"homework_id":"h3","subject_name":"Физика","description":"Лаба","date_prepared":"2026-10-14"},
                {"homework_id":"h4","subject_name":"Русский","description":"Сочинение","date_prepared":"2026-10-16"},
                {"homework_id":"h5","subject_name":"Биология","description":"Реферат","is_done":true},
                {"homework_id":"h6","subject_name":"Геометрия","description":"Без срока"}]"#,
        )
        .expect("json");
        let mut homeworks: Vec<Homework> = Vec::new();
        if let Some(items) = source.as_arr() {
            for item in items {
                homeworks.push(normalize::normalize_homework(item));
            }
        }
        let report = deadlines(&homeworks, "2026-10-13");
        assert_eq!(report.get("total").and_then(Json::as_i64), Some(6));
        assert_eq!(report.get("done").and_then(Json::as_i64), Some(1));
        assert_eq!(report.get("undone").and_then(Json::as_i64), Some(5));
        assert_eq!(report.get("overdue").and_then(Json::as_i64), Some(1));
        assert_eq!(report.get("progress").and_then(Json::as_f64), Some(0.167));
        let groups = report.get("groups").and_then(Json::as_arr).expect("группы");
        let count_of = |key: &str| -> i64 {
            groups
                .iter()
                .find(|group| group.get("key").map(Json::text) == Some(key.to_string()))
                .and_then(|group| group.get("count").and_then(Json::as_i64))
                .unwrap_or(-1)
        };
        assert_eq!(count_of("overdue"), 1);
        assert_eq!(count_of("today"), 1);
        assert_eq!(count_of("tomorrow"), 1);
        assert_eq!(count_of("week"), 1);
        assert_eq!(count_of("no-deadline"), 1);
        assert_eq!(count_of("done"), 1);
        assert_eq!(
            // Самое срочное несданное — просроченное (История, 10 октября).
            report.get_path("next.subjectName").map(Json::text),
            Some("История".to_string())
        );
        assert_eq!(
            // А это ближайшее из ещё не просроченных (Алгебра, 13 октября).
            report.get_path("nextUpcoming.subjectName").map(Json::text),
            Some("Алгебра".to_string())
        );
    }

    #[test]
    fn sparkline_is_drawn() {
        assert_eq!(sparkline(&[1.0], false), "▄");
        let text = sparkline(&[1.0, 2.0, 3.0], false);
        assert_eq!(text.chars().next(), Some('▁'));
        assert_eq!(text.chars().last(), Some('█'));
        assert_eq!(sparkline(&[3.0, 1.0], true), "▁█");
        assert_eq!(sparkline(&[], false), "");
    }
}
