//! Рейтинг класса: сборка таблицы (имена, место, дельты) и сводка.
//!
//! Порт `buildRankTable` + `summarizeRank` из JS-ядра — именно эти функции
//! вызываются на каждый показ вкладки «Рейтинг», поэтому в нативном CLI
//! и в мосте Node они работают на порядок быстрее на больших классах.

use crate::json::Json;
use crate::model::{RankBoard, RankRow, RankSummary};
use crate::normalize;
use crate::stats;
use crate::util;

/// Замена «Ученик <короткий id>» для тех, чьё имя не подтянулось.
pub fn short_id(person_id: &str) -> String {
    let trimmed = person_id.trim();
    if trimmed.is_empty() {
        return "Неизвестный ученик".to_string();
    }
    let head: String = trimmed.chars().take(8).collect();
    format!("Ученик {}", head)
}

/// Полная таблица рейтинга: имена, флаг «это я», цвет, место, дельты.
///
/// `names` — объект вида `{"<personId>": "Иванов Иван"}`.
pub fn build_rank_table(members: &[Json], names: &Json, me_id: &str) -> Vec<RankRow> {
    let mut rows: Vec<RankRow> = Vec::with_capacity(members.len());
    for (index, member) in members.iter().enumerate() {
        let raw = normalize::normalize_rank_member(member, index);
        let name = match names.get(&raw.person_id) {
            Some(Json::Str(value)) if !value.trim().is_empty() => value.clone(),
            _ => short_id(&raw.person_id),
        };
        let trend_direction = match raw.place_delta {
            Some(delta) if delta > 0 => 1,
            Some(delta) if delta < 0 => -1,
            Some(_) => 0,
            None => stats::trend_direction(raw.average, raw.previous_average, 0.005),
        };
        rows.push(RankRow {
            index: raw.index,
            person_id: raw.person_id,
            image_id: raw.image_id,
            place: raw.place,
            average: raw.average,
            status: raw.status,
            trend: raw.trend,
            previous_place: raw.previous_place,
            previous_average: raw.previous_average,
            place_delta: raw.place_delta,
            average_delta: raw.average_delta,
            name,
            is_me: !me_id.is_empty() && raw.person_id == me_id,
            color: stats::grade_color(raw.average).to_string(),
            trend_direction,
            rank_label: match raw.place {
                Some(place) => format!("#{}", place),
                None => "—".to_string(),
            },
        });
    }
    rows.sort_by(|a, b| {
        let left = a.place.unwrap_or(1_000_000_000);
        let right = b.place.unwrap_or(1_000_000_000);
        if left != right {
            return left.cmp(&right);
        }
        let left_average = a.average.unwrap_or(0.0);
        let right_average = b.average.unwrap_or(0.0);
        right_average
            .partial_cmp(&left_average)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

/// Сводка по таблице: KPI-плитки, гистограмма, отрывы (порт `summarizeRank`).
pub fn summarize_rank(rows: &[RankRow], _me_id: &str) -> RankSummary {
    let mut averages: Vec<f64> = Vec::new();
    for row in rows {
        if let Some(average) = row.average {
            if average.is_finite() {
                averages.push(average);
            }
        }
    }
    let mut sorted_averages = averages.clone();
    sorted_averages.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));

    let mut me: Option<&RankRow> = None;
    for row in rows {
        if row.is_me {
            me = Some(row);
            break;
        }
    }
    let leader = rows.first();

    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut next_above: Option<&RankRow> = None;
    if let Some(me) = me {
        for row in rows {
            let place = match row.place {
                Some(value) => value,
                None => continue,
            };
            let my_place = me.place.unwrap_or(i64::MAX);
            if place < my_place {
                ahead += 1;
                next_above = Some(row);
            } else if place > my_place {
                behind += 1;
            }
        }
    }

    let mut places: Vec<i64> = Vec::new();
    for row in rows {
        if let Some(place) = row.place {
            places.push(place);
        }
    }

    let class_mean = stats::mean(&averages);
    let my_average = me.and_then(|row| row.average);
    let leader_average = leader.and_then(|row| row.average);
    let next_average = next_above.and_then(|row| row.average);

    RankSummary {
        total: rows.len(),
        with_marks: averages.len(),
        class_average: util::round_opt(class_mean, 2),
        class_median: util::round_opt(stats::median(&averages), 2),
        class_min: stats::min(&averages),
        class_max: stats::max(&averages),
        my_average,
        my_place: me.and_then(|row| row.place),
        my_trend: me.map(|row| row.trend_direction).unwrap_or(0),
        my_delta: me.and_then(|row| row.average_delta),
        best_place: min_i64(&places),
        worst_place: max_i64(&places),
        above_class_average: match (my_average, class_mean) {
            (Some(mine), Some(mean)) => Some(mine >= mean),
            _ => None,
        },
        ahead_of_me: me.map(|_| ahead),
        behind_me: me.map(|_| behind),
        gap_to_leader: match (my_average, leader_average) {
            (Some(mine), Some(other)) => Some(util::round(other - mine, 2)),
            _ => None,
        },
        gap_to_next: match (my_average, next_average) {
            (Some(mine), Some(other)) => Some(util::round(other - mine, 2)),
            _ => None,
        },
        leader: leader.cloned(),
        my_row: me.cloned(),
        averages,
    }
}

fn min_i64(values: &[i64]) -> Option<i64> {
    let mut result: Option<i64> = None;
    for value in values {
        result = Some(match result {
            Some(current) if current <= *value => current,
            _ => *value,
        });
    }
    result
}

fn max_i64(values: &[i64]) -> Option<i64> {
    let mut result: Option<i64> = None;
    for value in values {
        result = Some(match result {
            Some(current) if current >= *value => current,
            _ => *value,
        });
    }
    result
}

/// Таблица + сводка за один проход — то, что отдаёт метод `rank` платформы.
pub fn build_rank_board(
    members: &[Json],
    names: &Json,
    me_id: &str,
    date: &str,
    subject_id: Option<&str>,
    subject_name: Option<&str>,
) -> RankBoard {
    let rows = build_rank_table(members, names, me_id);
    let summary = summarize_rank(&rows, me_id);
    RankBoard {
        rows,
        summary,
        date: date.to_string(),
        subject_id: subject_id.map(|value| value.to_string()),
        subject_name: subject_name.map(|value| value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members() -> Vec<Json> {
        vec![
            Json::parse(r#"{"personId":"a","rank":{"averageMarkFive":5,"rankPlace":1}}"#).unwrap(),
            Json::parse(r#"{"personId":"b","rank":{"averageMarkFive":4,"rankPlace":2},"previousRank":{"averageMarkFive":3.5,"rankPlace":3}}"#).unwrap(),
            Json::parse(r#"{"personId":"c","rank":{"averageMarkFive":3,"rankPlace":3}}"#).unwrap(),
        ]
    }

    #[test]
    fn table_has_names_places_and_flags() {
        let names = Json::parse(r#"{"a":"Иванов Иван","b":"Петров Пётр","c":"Сидорова Анна"}"#).unwrap();
        let rows = build_rank_table(&members(), &names, "b");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].place, Some(1));
        assert_eq!(rows[0].name, "Иванов Иван");
        assert!(!rows[0].is_me);
        assert!(rows[1].is_me);
        assert_eq!(rows[1].color, "yellow");
        assert_eq!(rows[1].place_delta, Some(1));
        assert_eq!(rows[1].rank_label, "#2");
    }

    #[test]
    fn summary_matches_js_expectations() {
        let rows = build_rank_table(&members(), &Json::Null, "b");
        let summary = summarize_rank(&rows, "b");
        assert_eq!(summary.total, 3);
        assert_eq!(summary.with_marks, 3);
        assert_eq!(summary.class_average, Some(4.0));
        assert_eq!(summary.class_median, Some(4.0));
        assert_eq!(summary.my_place, Some(2));
        assert_eq!(summary.gap_to_leader, Some(1.0));
        assert_eq!(summary.ahead_of_me, Some(1));
        assert_eq!(summary.behind_me, Some(1));
        assert_eq!(summary.best_place, Some(1));
        assert_eq!(summary.worst_place, Some(3));
        assert_eq!(summary.above_class_average, Some(true));
        assert_eq!(summary.leader.as_ref().map(|row| row.name.as_str()), Some("Ученик a"));
        let histogram_total: usize = summary
            .to_json()
            .get("histogram")
            .and_then(Json::as_arr)
            .unwrap()
            .iter()
            .map(|bucket| bucket.get("count").and_then(Json::as_i64).unwrap_or(0) as usize)
            .sum();
        assert_eq!(histogram_total, 3);
    }

    #[test]
    fn board_is_serializable() {
        let board = build_rank_board(
            &members(),
            &Json::parse(r#"{"a":"Иванов Иван"}"#).unwrap(),
            "a",
            "2026-10-12",
            Some("1"),
            Some("Алгебра"),
        );
        let json = board.to_json();
        assert_eq!(json.get("date").map(Json::text), Some("2026-10-12".to_string()));
        assert_eq!(json.get("subjectName").map(Json::text), Some("Алгебра".to_string()));
        assert_eq!(json.get("rows").and_then(Json::as_arr).map(|rows| rows.len()), Some(3));
        assert_eq!(
            json.get_path("summary.myPlace").and_then(Json::as_i64),
            Some(1)
        );
    }
}
