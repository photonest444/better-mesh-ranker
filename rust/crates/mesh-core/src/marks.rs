//! Сводка по оценкам: средняя, средняя взвешенная по весу работы, медиана,
//! распределение по предметам и по значениям — порт `summarizeMarks` из JS-ядра.

use crate::model::{Mark, MarksSummary, SubjectMarksSummary};
use crate::stats;
use crate::util;

/// Предметы сгруппированы по `subjectId`, а если его нет — по названию.
fn subject_key(mark: &Mark) -> String {
    if !mark.subject_id.is_empty() {
        mark.subject_id.clone()
    } else {
        mark.subject_name.clone()
    }
}

pub fn summarize_marks(marks: &[Mark]) -> MarksSummary {
    let mut values: Vec<f64> = Vec::new();
    let mut weighted_sum = 0.0;
    let mut weights = 0.0;

    for mark in marks {
        let value = match mark.value {
            Some(value) if value.is_finite() => value,
            _ => continue,
        };
        values.push(value);
        let weight = if mark.weight > 0.0 { mark.weight } else { 1.0 };
        weighted_sum += value * weight;
        weights += weight;
    }

    // Группировка по предметам (порядок первого появления сохраняется).
    let mut keys: Vec<String> = Vec::new();
    let mut groups: Vec<SubjectMarksSummary> = Vec::new();
    for mark in marks {
        let key = subject_key(mark);
        let position = match keys.iter().position(|item| *item == key) {
            Some(index) => index,
            None => {
                keys.push(key.clone());
                groups.push(SubjectMarksSummary {
                    subject_id: mark.subject_id.clone(),
                    subject_name: mark.subject_name.clone(),
                    count: 0,
                    average: None,
                    median: None,
                    color: "none".to_string(),
                    marks: Vec::new(),
                });
                groups.len() - 1
            }
        };
        groups[position].marks.push(mark.clone());
        groups[position].count += 1;
    }

    let mut subject_list: Vec<SubjectMarksSummary> = Vec::with_capacity(groups.len());
    for mut group in groups {
        let mut group_values: Vec<f64> = Vec::new();
        for mark in &group.marks {
            if let Some(value) = mark.value {
                if value.is_finite() {
                    group_values.push(value);
                }
            }
        }
        let average = stats::mean(&group_values);
        group.average = util::round_opt(average, 2);
        group.median = util::round_opt(stats::median(&group_values), 2);
        group.color = stats::grade_color(average).to_string();
        subject_list.push(group);
    }
    subject_list.sort_by(|a, b| {
        let left = a.average.unwrap_or(0.0);
        let right = b.average.unwrap_or(0.0);
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });

    // Распределение по значениям: 5, 4, 3, 2, 1.
    let mut by_value: Vec<(i64, usize, String)> = Vec::with_capacity(5);
    for value in [5i64, 4, 3, 2, 1] {
        let count = values.iter().filter(|item| item.round() as i64 == value).count();
        by_value.push((value, count, stats::grade_color(Some(value as f64)).to_string()));
    }

    // Последняя (самая свежая) оценка.
    let mut sorted: Vec<Mark> = marks.to_vec();
    sorted.sort_by(|a, b| b.date.cmp(&a.date));
    let last_mark = sorted.first().cloned();

    MarksSummary {
        count: marks.len(),
        with_value: values.len(),
        average: util::round_opt(stats::mean(&values), 2),
        weighted_average: if weights > 0.0 {
            util::round_opt(Some(weighted_sum / weights), 2)
        } else {
            None
        },
        median: util::round_opt(stats::median(&values), 2),
        best: stats::max(&values),
        worst: stats::min(&values),
        by_subject: subject_list,
        by_value,
        last_mark,
    }
}

/// «Искры» последних оценок: N самых свежих значений (для карточек предметов).
pub fn recent_marks(marks: &[Mark], limit: usize) -> Vec<Mark> {
    let mut sorted: Vec<Mark> = marks.to_vec();
    sorted.sort_by(|a, b| b.date.cmp(&a.date));
    sorted.truncate(limit);
    sorted
}

/// Оценки за конкретный предмет.
pub fn marks_of_subject<'a>(marks: &'a [Mark], subject_id: &str) -> Vec<&'a Mark> {
    marks.iter().filter(|mark| mark.subject_id == subject_id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Json;
    use crate::normalize;

    fn sample() -> Vec<Mark> {
        let source = Json::parse(
            r#"[{"id":1,"value":5,"weight":1,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-01"},
                {"id":2,"value":4,"weight":3,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-02"},
                {"id":3,"value":3,"weight":1,"subject_id":"2","subject_name":"Физика","date":"2026-10-03"}]"#,
        )
        .expect("json");
        let mut marks: Vec<Mark> = Vec::new();
        if let Some(items) = source.as_arr() {
            for item in items {
                marks.push(normalize::normalize_mark(item));
            }
        }
        marks
    }

    #[test]
    fn summary_averages_and_weighting() {
        let summary = summarize_marks(&sample());
        assert_eq!(summary.count, 3);
        assert_eq!(summary.with_value, 3);
        assert_eq!(summary.average, Some(4.0));
        assert_eq!(summary.weighted_average, Some(4.0)); // (5*1 + 4*3 + 3*1) / 5
        assert_eq!(summary.best, Some(5.0));
        assert_eq!(summary.worst, Some(3.0));
        assert_eq!(summary.last_mark.as_ref().map(|mark| mark.date.clone()), Some("2026-10-03".to_string()));
    }

    #[test]
    fn grouping_and_distribution() {
        let summary = summarize_marks(&sample());
        assert_eq!(summary.by_subject.len(), 2);
        assert_eq!(summary.by_subject[0].subject_name, "Алгебра");
        assert_eq!(summary.by_subject[0].count, 2);
        assert_eq!(summary.by_subject[0].average, Some(4.5));
        assert_eq!(summary.by_subject[0].color, "yellow");
        let five = summary.by_value.iter().find(|(value, _, _)| *value == 5).unwrap();
        assert_eq!(five.1, 1);
    }

    #[test]
    fn empty_input_is_safe() {
        let summary = summarize_marks(&[]);
        assert_eq!(summary.count, 0);
        assert_eq!(summary.average, None);
        assert!(summary.by_subject.is_empty());
    }

    #[test]
    fn recent_marks_are_sorted() {
        let recent = recent_marks(&sample(), 2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].date, "2026-10-03");
    }
}
