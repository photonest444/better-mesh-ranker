//! Микробенчмарк ядра: детерминированные «синтетические» данные МЭШ,
//! замер разбора, сборки таблицы рейтинга, сводки и CSV.
//!
//! Запуск: `mesh-rank bench --students 26 --iterations 200`
//! Повторяемость: генератор инициализируется фиксированным seed,
//! поэтому числа сравнимы между запусками и машинами.

use std::time::Instant;

use crate::format::{self, Column, ColumnFormat};
use crate::json::Json;
use crate::model::Mark;
use crate::normalize;
use crate::rank;
use crate::stats;
use crate::util;

/// Простой xorshift-генератор: без зависимостей и полностью воспроизводимый.
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng { state: if seed == 0 { 0x2545F4914F6CDD1D } else { seed } }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// Число в диапазоне `[min, max)`.
    pub fn range(&mut self, min: f64, max: f64) -> f64 {
        let unit = (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        min + (max - min) * unit
    }

    pub fn int(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        min + (self.next_u64() % (max - min) as u64) as i64
    }
}

/// Синтетический ответ МЭШ «рейтинг класса».
pub fn synthetic_members(students: usize, seed: u64) -> Json {
    let mut rng = Rng::new(seed);
    let mut items: Vec<Json> = Vec::with_capacity(students);
    // Средние баллы распределены 2.8 … 5.0, места — по убыванию балла.
    let mut averages: Vec<f64> = Vec::with_capacity(students);
    for _ in 0..students {
        averages.push(util::round(rng.range(2.8, 5.0), 2));
    }
    averages.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    for (index, average) in averages.iter().enumerate() {
        let previous_average = util::round(average - rng.range(-0.3, 0.3), 2);
        let previous_place = rng.int(1, students as i64 + 1);
        items.push(Json::object(vec![
            ("personId", Json::str(format!("person-{:04}", index))),
            (
                "rank",
                Json::object(vec![
                    ("averageMarkFive", Json::Num(*average)),
                    ("rankPlace", Json::Num(index as f64 + 1.0)),
                    ("rankStatus", Json::str(if *average >= 4.5 { "TOP" } else { "OK" })),
                    ("trend", Json::str("0")),
                ]),
            ),
            (
                "previousRank",
                Json::object(vec![
                    ("averageMarkFive", Json::Num(previous_average)),
                    ("rankPlace", Json::Num(previous_place as f64)),
                ]),
            ),
        ]));
    }
    Json::Arr(items)
}

/// Синтетические оценки за период.
pub fn synthetic_marks(count: usize, subjects: usize, seed: u64) -> Vec<Mark> {
    let mut rng = Rng::new(seed);
    let mut source: Vec<Json> = Vec::with_capacity(count);
    for index in 0..count {
        let subject_index = rng.int(1, subjects as i64 + 1);
        let value = rng.int(2, 6);
        let day = rng.int(1, 29);
        source.push(Json::object(vec![
            ("id", Json::Num(index as f64)),
            ("value", Json::Num(value as f64)),
            ("weight", Json::Num(rng.int(1, 4) as f64)),
            ("subject_id", Json::str(format!("{}", subject_index))),
            ("subject_name", Json::str(format!("Предмет {}", subject_index))),
            (
                "date",
                Json::str(format!("2026-09-{:02}", day)),
            ),
        ]));
    }
    let mut marks: Vec<Mark> = Vec::with_capacity(count);
    for item in &source {
        marks.push(normalize::normalize_mark(item));
    }
    marks
}

fn milliseconds(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Полный прогон бенчмарка. Возвращает отчёт в виде JSON (его удобно
/// показывать в `--json`, в логах CI и в панели диагностики приложения).
pub fn run(students: usize, marks_count: usize, iterations: usize) -> Json {
    let iterations = iterations.max(1);
    let students = students.max(1);

    let build_start = Instant::now();
    let members = synthetic_members(students, 42);
    let build_ms = milliseconds(build_start);
    let serialize_start = Instant::now();
    let serialized = members.to_json_string();
    let serialize_ms = milliseconds(serialize_start);
    let parse_start = Instant::now();
    let parsed = Json::parse(&serialized).unwrap_or(Json::Null);
    let parse_ms = milliseconds(parse_start);
    let members_slice = parsed.as_arr().map(|items| items.to_vec()).unwrap_or_default();

    // Имена «как из кэша» — тогда бенчмарк не зависит от сети.
    let mut name_entries: Vec<(String, Json)> = Vec::new();
    for index in 0..students {
        name_entries.push((
            format!("person-{:04}", index),
            Json::str(format!("Ученик Номер{:04}", index)),
        ));
    }
    let names = Json::Obj(name_entries);

    let table_start = Instant::now();
    let mut last_rows = 0usize;
    let mut checksum = 0.0f64;
    for _ in 0..iterations {
        let rows = rank::build_rank_table(&members_slice, &names, "person-0000");
        let summary = rank::summarize_rank(&rows, "person-0000");
        last_rows = rows.len();
        checksum += summary.class_average.unwrap_or(0.0);
    }
    let table_ms = milliseconds(table_start) / iterations as f64;
    let per_second = if table_ms > 0.0 { 1000.0 / table_ms } else { f64::INFINITY };

    let marks = synthetic_marks(marks_count, 14, 7);
    let marks_start = Instant::now();
    let mut marks_checksum = 0.0f64;
    for _ in 0..iterations {
        let summary = crate::marks::summarize_marks(&marks);
        marks_checksum += summary.average.unwrap_or(0.0);
    }
    let marks_ms = milliseconds(marks_start) / iterations as f64;

    let json_start = Instant::now();
    let mut bytes = 0usize;
    for _ in 0..iterations {
        bytes = members.to_json_string().len();
    }
    let json_ms = milliseconds(json_start) / iterations as f64;

    let csv_start = Instant::now();
    let csv = {
        let rows = rank::build_rank_table(&members_slice, &names, "person-0000");
        let mut json_rows: Vec<Json> = Vec::with_capacity(rows.len());
        for row in &rows {
            json_rows.push(row.to_json());
        }
        let columns = vec![
            Column::new("place", "Место", ColumnFormat::Place),
            Column::new("name", "Ученик", ColumnFormat::Raw),
            Column::new("average", "Средний балл", ColumnFormat::Mark),
        ];
        format::to_csv(&json_rows, &columns, Some("Рейтинг класса"), ';', true)
    };
    let csv_ms = milliseconds(csv_start);

    let averages: Vec<f64> = marks
        .iter()
        .filter_map(|mark| mark.value)
        .collect();
    let describe_start = Instant::now();
    let mut statistics = Json::Null;
    for _ in 0..iterations {
        statistics = stats::describe(&averages);
    }
    let describe_ms = milliseconds(describe_start) / iterations as f64;

    Json::object(vec![
        ("engine", Json::str("rust")),
        ("version", Json::str(crate::VERSION)),
        ("students", Json::Num(students as f64)),
        ("marks", Json::Num(marks_count as f64)),
        ("iterations", Json::Num(iterations as f64)),
        ("rows", Json::Num(last_rows as f64)),
        (
            "timings",
            Json::object(vec![
                ("buildMs", Json::Num(util::round(build_ms, 3))),
                ("serializeMs", Json::Num(util::round(serialize_ms, 3))),
                ("parseMs", Json::Num(util::round(parse_ms, 3))),
                ("rankTableMs", Json::Num(util::round(table_ms, 4))),
                ("rankTablePerSecond", Json::Num(util::round(per_second, 1))),
                ("marksSummaryMs", Json::Num(util::round(marks_ms, 4))),
                ("jsonStringifyMs", Json::Num(util::round(json_ms, 4))),
                ("csvMs", Json::Num(util::round(csv_ms, 4))),
                ("describeMs", Json::Num(util::round(describe_ms, 4))),
            ]),
        ),
        ("csvBytes", Json::Num(csv.len() as f64)),
        ("checksum", Json::Num(util::round(checksum + marks_checksum, 4))),
        ("statistics", statistics),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_data_is_reproducible() {
        let first = synthetic_members(10, 7);
        let second = synthetic_members(10, 7);
        assert_eq!(first.to_json_string(), second.to_json_string());
        assert_eq!(first.as_arr().map(|items| items.len()), Some(10));
        let places: Vec<i64> = first
            .as_arr()
            .unwrap()
            .iter()
            .map(|item| item.get_path("rank.rankPlace").and_then(Json::as_i64).unwrap_or(0))
            .collect();
        assert_eq!(places, (1..=10).collect::<Vec<i64>>());
    }

    #[test]
    fn run_reports_timings() {
        let report = run(26, 120, 5);
        assert_eq!(report.get("rows").and_then(Json::as_i64), Some(26));
        let per_second = report.get_path("timings.rankTablePerSecond").and_then(Json::as_f64).unwrap_or(0.0);
        assert!(per_second > 0.0);
        assert!(report.get("checksum").and_then(Json::as_f64).is_some());
    }
}
