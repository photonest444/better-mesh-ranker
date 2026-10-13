//! `mesh-rank selftest` — самопроверка ядра без сети и без `cargo test`.
//!
//! Полезно, когда бинарник скачали готовым: одна команда проверяет, что
//! разбор токена, даты, рейтинг, статистика, прогноз, дедлайны и CSV
//! работают именно так, как ожидает приложение.

use mesh_core::bridge::{Session, SessionOptions};
use mesh_core::format;
use mesh_core::insights::{self, Snapshot};
use mesh_core::json::Json;
use mesh_core::marks;
use mesh_core::normalize;
use mesh_core::rank;
use mesh_core::stats;
use mesh_core::token;
use mesh_core::util;

struct Report {
    total: usize,
    failed: usize,
}

impl Report {
    fn check(&mut self, name: &str, condition: bool) {
        self.total += 1;
        if condition {
            println!("  ✓ {}", name);
        } else {
            self.failed += 1;
            println!("  ✗ {}", name);
        }
    }
}

fn marks_from(json: &str) -> Vec<mesh_core::model::Mark> {
    let parsed = Json::parse(json).unwrap_or(Json::Arr(Vec::new()));
    let mut out: Vec<mesh_core::model::Mark> = Vec::new();
    for item in normalize::marks_payload(&parsed) {
        out.push(normalize::normalize_mark(&item));
    }
    out
}

/// Запускает самопроверку; возвращает код выхода.
pub fn run() -> i32 {
    println!("Самопроверка mesh-core {}\n", mesh_core::VERSION);
    let mut report = Report { total: 0, failed: 0 };

    // --- токен -------------------------------------------------------------
    let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo0MTAyNDQ0ODAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    report.check(
        "токен находится в JSON, HTML и URL",
        token::extract_token_from_text(jwt).as_deref() == Some(jwt)
            && token::extract_token_from_text(&format!("<b>{{\"access_token\":\"{}\"}}</b>", jwt)).as_deref() == Some(jwt)
            && token::extract_token_from_url(&format!("https://school.mos.ru/#access_token={}", jwt)).as_deref() == Some(jwt),
    );
    let info = token::describe_token(Some(jwt), 0);
    report.check(
        "JWT разбирается: срок действия и маска",
        info.get("kind").map(Json::text).as_deref() == Some("jwt")
            && info.get("expiresAt").and_then(Json::as_i64) == Some(4_102_444_800_000)
            && info.get("mask").map(Json::text).unwrap_or_default().contains('…'),
    );
    report.check(
        "короткие демо-токены распознаются отдельно",
        token::extract_loose_token("{\"token\":\"mock-token-1\"}").as_deref() == Some("mock-token-1"),
    );

    // --- даты --------------------------------------------------------------
    report.check(
        "календарные даты считаются без часовых поясов",
        util::add_days("2026-10-12", -7) == "2026-10-05"
            && util::days_between("2026-09-01", "2026-10-12") == 41
            && util::school_year_start("2026-10-12") == "2026-09-01"
            && util::to_iso("05.10.2026") == "2026-10-05",
    );
    report.check(
        "русские даты и склонения",
        format::date_ru("2026-10-12", true) == "понедельник, 12 октября 2026"
            && format::plural_ru(5, "ученик", "ученика", "учеников") == "учеников",
    );

    // --- рейтинг -----------------------------------------------------------
    let members = Json::parse(
        r#"[{"personId":"a","rank":{"averageMarkFive":5,"rankPlace":1}},
            {"personId":"b","rank":{"averageMarkFive":4,"rankPlace":2},"previousRank":{"averageMarkFive":3.5,"rankPlace":3}},
            {"personId":"c","rank":{"averageMarkFive":3,"rankPlace":3}}]"#,
    )
    .unwrap_or(Json::Null);
    let members_list = members.as_arr().map(|items| items.to_vec()).unwrap_or_default();
    let names = Json::parse(r#"{"a":"Иванов Иван","b":"Петров Пётр","c":"Сидорова Анна"}"#).unwrap_or(Json::obj());
    let rows = rank::build_rank_table(&members_list, &names, "b");
    report.check(
        "таблица рейтинга: места, имена, флаги и цвета",
        rows.len() == 3
            && rows[0].name == "Иванов Иван"
            && rows[1].is_me
            && rows[1].place_delta == Some(1)
            && rows[0].color == "green",
    );
    let summary = rank::summarize_rank(&rows, "b");
    report.check(
        "сводка: средний балл класса, моё место, отрыв",
        summary.class_average == Some(4.0)
            && summary.my_place == Some(2)
            && summary.gap_to_leader == Some(1.0)
            && summary.ahead_of_me == Some(1)
            && summary.behind_me == Some(1),
    );

    // --- статистика --------------------------------------------------------
    report.check(
        "статистика: медиана, квантили, цвета, места",
        stats::mean(&[5.0, 4.0, 3.0]) == Some(4.0)
            && stats::median(&[5.0, 3.0, 4.0, 4.0]) == Some(4.0)
            && stats::grade_color(Some(4.4)) == "yellow"
            && stats::place_of(&[5.0, 4.0, 3.0], Some(4.0)) == Some(2),
    );

    // --- оценки ------------------------------------------------------------
    let marks_list = marks_from(
        r#"[{"value":5,"weight":1,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-01"},
            {"value":4,"weight":3,"subject_id":"1","subject_name":"Алгебра","date":"2026-10-02"},
            {"value":3,"weight":1,"subject_id":"2","subject_name":"Физика","date":"2026-10-03"}]"#,
    );
    let marks_summary = marks::summarize_marks(&marks_list);
    report.check(
        "сводка по оценкам: средний, взвешенный, распределение",
        marks_summary.average == Some(4.0)
            && marks_summary.weighted_average == Some(4.0)
            && marks_summary.by_subject.len() == 2
            && marks_summary.with_value == 3,
    );

    // --- аналитика ---------------------------------------------------------
    // текущий средний 4.0 (оценки 5, 4, 3), цель 4.2, осталась одна работа
    let plan = insights::forecast(&marks_list, 4.2, 1);
    report.check(
        "прогноз до цели: достижимость и нужные «пятёрки»",
        plan.get("status").map(Json::text).as_deref() == Some("achievable")
            && plan.get("fivesNeeded").and_then(Json::as_i64) == Some(1)
            && plan.get("neededAverage").and_then(Json::as_f64) == Some(4.8),
    );
    // цель 4.6 при одной оставшейся работе недостижима (максимум 4.25)
    let unreachable = insights::forecast(&marks_list, 4.6, 1);
    report.check(
        "прогноз честно говорит «нет», когда цель недостижима",
        unreachable.get("status").map(Json::text).as_deref() == Some("unreachable")
            && unreachable.get("maxPossible").and_then(Json::as_f64) == Some(4.25),
    );
    let simulation = insights::what_if(&marks_list, &[5.0]);
    report.check(
        "«что если»: средний балл после новой оценки",
        simulation.get("before").and_then(Json::as_f64) == Some(4.0)
            && simulation.get("after").and_then(Json::as_f64) == Some(4.25),
    );
    let impact = insights::subject_impact(&marks_list, 5);
    report.check(
        "влияние оценок: слабые предметы расти быстрее",
        impact
            .as_arr()
            .and_then(|items| items.first())
            .map(|row| row.get("subjectName").map(Json::text).unwrap_or_default())
            .as_deref()
            == Some("Физика"),
    );

    // --- история -----------------------------------------------------------
    let snapshots = vec![
        Snapshot {
            date: "2026-09-01".into(),
            subject_id: None,
            my_place: Some(7),
            my_average: Some(4.2),
            class_average: Some(4.0),
            total: 26,
            saved_at: None,
        },
        Snapshot {
            date: "2026-10-12".into(),
            subject_id: None,
            my_place: Some(3),
            my_average: Some(4.55),
            class_average: Some(4.02),
            total: 26,
            saved_at: None,
        },
    ];
    let series = insights::history_series(&snapshots, None);
    report.check(
        "динамика: дельта места, лучший результат, спарклайн",
        series.get("placeDelta").and_then(Json::as_i64) == Some(4)
            && series.get("bestPlace").and_then(Json::as_i64) == Some(3)
            && series.get("sparkline").map(Json::text).unwrap_or_default().chars().count() == 2,
    );

    // --- дедлайны ----------------------------------------------------------
    let homeworks = normalize::payload_list(
        &Json::parse(
            r#"{"payload":[{"homework_id":"h1","subject_name":"История","description":"§ 12","date_prepared":"2026-10-10"},
                            {"homework_id":"h2","subject_name":"Алгебра","description":"Номера","date_prepared":"2026-10-13"}]}"#,
        )
        .unwrap_or(Json::Null),
    );
    let mut homework_list: Vec<mesh_core::model::Homework> = Vec::new();
    for item in &homeworks {
        homework_list.push(normalize::normalize_homework(item));
    }
    let deadlines = insights::deadlines(&homework_list, "2026-10-13");
    report.check(
        "дедлайны: просрочено, сегодня, прогресс",
        deadlines.get("total").and_then(Json::as_i64) == Some(2)
            && deadlines.get("overdue").and_then(Json::as_i64) == Some(1)
            && deadlines.get("progress").and_then(Json::as_f64) == Some(0.0),
    );

    // --- CSV ---------------------------------------------------------------
    let csv = format::to_csv(
        &[Json::object(vec![
            ("name", Json::str("Иванов Иван")),
            ("average", Json::Num(4.75)),
        ])],
        &[
            format::Column::new("name", "Ученик", format::ColumnFormat::Raw),
            format::Column::new("average", "Средний балл", format::ColumnFormat::Mark),
        ],
        Some("Рейтинг класса"),
        ';',
        true,
    );
    report.check(
        "CSV: BOM, «;» и правильное экранирование",
        csv.starts_with('\u{feff}') && csv.contains("Иванов Иван;4.75") && csv.contains("\r\n"),
    );

    // --- мост --------------------------------------------------------------
    let mut session = Session::new(SessionOptions::default());
    let bridge = session.handle("hello", &Json::obj());
    report.check(
        "мост JSON-lines отвечает и знает свои методы",
        bridge
            .map(|value| value.get("methods").and_then(Json::as_arr).map(|items| items.len() >= 30).unwrap_or(false))
            .unwrap_or(false),
    );

    println!("\nПроверок: {}, ошибок: {}", report.total, report.failed);
    if report.failed > 0 {
        println!("Самопроверка провалена");
        1
    } else {
        println!("Все проверки пройдены — ядро работает корректно");
        0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn selftest_passes() {
        assert_eq!(super::run(), 0);
    }
}
