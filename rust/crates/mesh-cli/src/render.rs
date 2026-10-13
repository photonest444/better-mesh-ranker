//! Вывод в терминал: цвета оценок, таблица рейтинга, сводки, дедлайны и динамика.
//!
//! Всё оформление повторяет интерфейс приложения (те же цвета и подписи),
//! чтобы CLI не приходилось «переучивать» глазами.

use mesh_core::format;
use mesh_core::insights;
use mesh_core::json::Json;
use mesh_core::model::{Lesson, MarksSummary, RankSummary, Subject};
use mesh_core::util;

const RESET: &str = "\u{1b}[0m";
const BOLD: &str = "\u{1b}[1m";
const DIM: &str = "\u{1b}[2m";
const GREEN: &str = "\u{1b}[92m";
const YELLOW: &str = "\u{1b}[93m";
const ORANGE: &str = "\u{1b}[38;5;208m";
const RED: &str = "\u{1b}[91m";
const BLUE: &str = "\u{1b}[94m";

/// Включён ли цвет: `--no-color`, переменная `NO_COLOR` или перенаправленный вывод.
#[derive(Clone, Copy)]
pub struct Style {
    pub color: bool,
}

impl Style {
    pub fn from_flags(no_color: bool) -> Style {
        let forced = std::env::var("MESH_FORCE_COLOR").is_ok();
        let env_disabled = std::env::var("NO_COLOR").is_ok();
        let terminal = {
            use std::io::IsTerminal;
            std::io::stdout().is_terminal()
        };
        Style {
            color: if forced { true } else { !no_color && !env_disabled && terminal },
        }
    }

    pub fn paint(&self, text: &str, color: &str) -> String {
        if self.color {
            format!("{}{}{}", color, text, RESET)
        } else {
            text.to_string()
        }
    }

    pub fn bold(&self, text: &str) -> String {
        self.paint(text, BOLD)
    }

    pub fn dim(&self, text: &str) -> String {
        self.paint(text, DIM)
    }

    pub fn mark(&self, value: Option<f64>, text: &str) -> String {
        let color = match mesh_core::stats::grade_color(value) {
            "green" => GREEN,
            "yellow" => YELLOW,
            "orange" => ORANGE,
            "red" => RED,
            _ => DIM,
        };
        self.paint(text, color)
    }

    pub fn trend(&self, direction: i32) -> String {
        let (arrow, color) = match direction {
            1 => ("▲", GREEN),
            -1 => ("▼", RED),
            _ => ("=", DIM),
        };
        self.paint(arrow, color)
    }
}

/// Полоса уровня оценки (пять сегментов, как в интерфейсе).
pub fn bar(value: Option<f64>, style: &Style) -> String {
    let filled = match value {
        Some(value) if value.is_finite() => ((value / 5.0) * 5.0).round().clamp(0.0, 5.0) as usize,
        _ => 0,
    };
    let color = match mesh_core::stats::grade_color(value) {
        "green" => GREEN,
        "yellow" => YELLOW,
        "orange" => ORANGE,
        "red" => RED,
        _ => DIM,
    };
    let text = format!("{}{}", "█".repeat(filled), "░".repeat(5 - filled));
    style.paint(&text, color)
}

fn pad(text: &str, width: usize) -> String {
    let mut out = text.to_string();
    let visible = strip_ansi(text).chars().count();
    if visible > width {
        let plain = strip_ansi(text);
        out = plain.chars().take(width.saturating_sub(1)).collect::<String>() + "…";
    } else {
        for _ in visible..width {
            out.push(' ');
        }
        out.push(' ');
    }
    out
}

/// Убирает ANSI-последовательности, чтобы считать ширину колонок.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Шапка раздела.
pub fn title(text: &str, style: &Style) {
    println!("\n{}", style.bold(text));
}

/// Таблица рейтинга класса.
pub fn rank_table(rows: &[mesh_core::model::RankRow], style: &Style, limit: usize, me_label: bool) {
    let shown = if limit == 0 || limit >= rows.len() { rows.len() } else { limit };
    let name_width = rows
        .iter()
        .take(shown)
        .map(|row| row.name.chars().count())
        .max()
        .unwrap_or(10)
        .clamp(10, 32);
    for (index, row) in rows.iter().take(shown).enumerate() {
        let marker = if row.is_me && me_label { style.paint("→", BLUE) } else { " ".to_string() };
        let place = match row.place {
            Some(place) => format!("{:>3}", place),
            None => "  —".to_string(),
        };
        let delta = match row.place_delta {
            Some(delta) if delta > 0 => style.paint(&format!("+{}", delta), GREEN),
            Some(delta) if delta < 0 => style.paint(&format!("{}", delta), RED),
            Some(_) => style.dim("0"),
            None => style.dim("·"),
        };
        let average = match row.average {
            Some(value) => style.mark(Some(value), &format!("{:.2}", value)),
            None => style.dim("—"),
        };
        let average_delta = match row.average_delta {
            Some(delta) if delta > 0.0 => style.paint(&format!("+{:.2}", delta), GREEN),
            Some(delta) if delta < 0.0 => style.paint(&format!("{:.2}", delta), RED),
            _ => style.dim("0.00"),
        };
        println!(
            "{} {} {} {} {} {} {}",
            marker,
            style.dim(&place),
            delta,
            pad(&row.name, name_width),
            average,
            average_delta,
            bar(row.average, style)
        );
        if index + 1 == shown && shown < rows.len() {
            println!("{}", style.dim(&format!("… и ещё {} учеников (--top 0 — показать всех)", rows.len() - shown)));
        }
    }
}

/// Сводка: место, средний балл, отрывы, лидер.
pub fn rank_summary(summary: &RankSummary, style: &Style) {
    let total = summary.total.to_string();
    println!(
        "{}  {} {} / {}",
        style.bold("Моё место:"),
        match summary.my_place {
            Some(place) => style.mark(summary.my_average, &format!("#{}", place)),
            None => "—".to_string(),
        },
        style.dim("из"),
        total
    );
    println!(
        "{} {}   {} {}   {} {}",
        style.bold("Мой средний:"),
        style.mark(summary.my_average, &format::mark_short(summary.my_average)),
        style.bold("По классу:"),
        style.mark(summary.class_average, &format::mark_short(summary.class_average)),
        style.bold("Лидер:"),
        match &summary.leader {
            Some(leader) => format!("{} ({})", leader.name, format::mark_short(leader.average)),
            None => "—".to_string(),
        }
    );
    println!(
        "{} {}   {} {}   {} {}",
        style.bold("До лидера:"),
        format::mark_short(summary.gap_to_leader),
        style.bold("Впереди/позади:"),
        format!(
            "{}/{}",
            summary.ahead_of_me.unwrap_or(0),
            summary.behind_me.unwrap_or(0)
        ),
        style.bold("Медиана класса:"),
        format::mark_short(summary.class_median)
    );
    let buckets = mesh_core::stats::histogram(&summary.averages, 2.0, 5.0, 0.5);
    if !buckets.is_empty() {
        title("Распределение средних баллов", style);
        let widest = buckets.iter().map(|bucket| bucket.count).max().unwrap_or(1).max(1);
        for bucket in buckets {
            let width = ((bucket.count as f64 / widest as f64) * 24.0).round() as usize;
            println!(
                "  {} {} {}",
                style.dim(&format!("{:>9}", bucket.label)),
                style.paint(&"█".repeat(width), BLUE),
                bucket.count
            );
        }
    }
    let spark = insights::sparkline(&summary.averages, true);
    if !spark.is_empty() {
        println!(
            "{} {} {}",
            style.bold("Сильнейшие/слабейшие:"),
            spark,
            style.dim(&format::students_count(summary.total as i64))
        );
    }
}

pub fn subjects_table(subjects: &[Subject], style: &Style) {
    let name_width = subjects
        .iter()
        .map(|subject| subject.name.chars().count())
        .max()
        .unwrap_or(10)
        .clamp(10, 32);
    for subject in subjects {
        let exam = if subject.is_exam {
            style.paint(" экзамен", YELLOW)
        } else {
            String::new()
        };
        println!(
            "{} {} {} {}",
            pad(&subject.name, name_width),
            style.mark(subject.average, &format::mark_short(subject.average)),
            match subject.place {
                Some(place) => style.dim(&format!("место #{:<3}", place)),
                None => style.dim("место —  "),
            },
            format!("{}{}", bar(subject.average, style), exam)
        );
    }
}

pub fn marks_summary(summary: &MarksSummary, style: &Style) {
    println!(
        "{} {}   {} {}   {} {}",
        style.bold("Оценок:"),
        summary.count,
        style.bold("Средний:"),
        style.mark(summary.average, &format::mark_short(summary.average)),
        style.bold("Взвешенный:"),
        format::mark_short(summary.weighted_average)
    );
    let mut spark = String::new();
    for (value, count, _) in &summary.by_value {
        if *count > 0 {
            spark.push_str(&format!(
                "{}{} ",
                style.mark(Some(*value as f64), &format!("{}", value)),
                style.dim(&format!("×{}", count))
            ));
        }
    }
    if !spark.is_empty() {
        println!("{} {}", style.bold("Распределение:"), spark.trim_end());
    }
    println!("{}", style.bold("По предметам:"));
    subject_marks_table(&summary.by_subject, style);
}

pub fn subject_marks_table(subjects: &[mesh_core::model::SubjectMarksSummary], style: &Style) {
    let name_width = subjects
        .iter()
        .map(|subject| subject.subject_name.chars().count())
        .max()
        .unwrap_or(10)
        .clamp(10, 30);
    for subject in subjects.iter().take(12) {
        println!(
            "  {} {} {}",
            pad(&subject.subject_name, name_width),
            style.mark(subject.average, &format::mark_short(subject.average)),
            style.dim(&format!(
                "{} · медиана {}",
                format::marks_count(subject.count as i64),
                format::mark_short(subject.median)
            ))
        );
    }
}

/// Отчёт по дедлайнам домашних заданий.
pub fn deadlines(report: &Json, style: &Style) {
    let total = report.get("total").and_then(Json::as_i64).unwrap_or(0);
    let done = report.get("done").and_then(Json::as_i64).unwrap_or(0);
    let overdue = report.get("overdue").and_then(Json::as_i64).unwrap_or(0);
    let progress = report.get("progress").and_then(Json::as_f64).unwrap_or(0.0);
    println!(
        "{} {}   {} {}   {} {}",
        style.bold("Заданий:"),
        total,
        style.bold("Выполнено:"),
        style.paint(&format!("{} ({})", done, format::percent(Some(progress), 0)), GREEN),
        style.bold("Просрочено:"),
        if overdue > 0 {
            style.paint(&overdue.to_string(), RED)
        } else {
            style.dim("0")
        }
    );
    if let Some(next) = report.get("next") {
        if !next.is_null() {
            println!(
                "{} {} — {}{}",
                style.bold("Ближайшее:"),
                next.get("subjectName").map(Json::text).unwrap_or_default(),
                next.get("dueDate").map(Json::text).unwrap_or_default(),
                if next.get("description").map(Json::text).unwrap_or_default().is_empty() {
                    String::new()
                } else {
                    format!(" · {}", format::truncate(&next.get("description").map(Json::text).unwrap_or_default(), 70))
                }
            );
        }
    }
    let groups = report.get("groups").and_then(Json::as_arr).unwrap_or(&[]);
    for group in groups {
        let count = group.get("count").and_then(Json::as_i64).unwrap_or(0);
        if count == 0 {
            continue;
        }
        let key = group.get("key").map(Json::text).unwrap_or_default();
        let color = match key.as_str() {
            "overdue" => RED,
            "today" => ORANGE,
            "tomorrow" => YELLOW,
            "week" => BLUE,
            _ => DIM,
        };
        println!("  {} {}", style.paint(&format!("{:<12}", group.get("label").map(Json::text).unwrap_or_default()), color), count);
    }
}

/// Прогноз до цели.
pub fn forecast(plan: &Json, style: &Style) {
    let status = plan.get("status").map(Json::text).unwrap_or_default();
    println!(
        "{} {} → {}   {}",
        style.bold("Прогноз:"),
        format::mark_short(plan.get("average").and_then(Json::as_f64)),
        format::mark_short(plan.get("target").and_then(Json::as_f64)),
        match status.as_str() {
            "done" => style.paint("цель достигнута", GREEN),
            "achievable" => style.paint("достижимо", YELLOW),
            _ => style.paint("пока нет", RED),
        }
    );
    println!(
        "  {} {} (нужно среднее {} за {} работ)   {} {}",
        style.bold("Не хватает:"),
        format::mark_short(plan.get("gap").and_then(Json::as_f64)),
        format::mark_short(plan.get("neededAverage").and_then(Json::as_f64)),
        plan.get("remaining").and_then(Json::as_i64).unwrap_or(1),
        style.bold("Максимум сейчас:"),
        format::mark_short(plan.get("maxPossible").and_then(Json::as_f64))
    );
}

/// Динамика по сохранённым снимкам.
pub fn history(series: &Json, style: &Style) {
    let count = series.get("count").and_then(Json::as_i64).unwrap_or(0);
    if count == 0 {
        println!("{}", style.dim("Снимков пока нет — сохраните первый: mesh-rank history add"));
        return;
    }
    let sparkline = series.get("placeSparkline").map(Json::text).unwrap_or_default();
    println!(
        "{} {}   {} {}   {} {}",
        style.bold("Снимков:"),
        count,
        style.bold("Место:"),
        format!(
            "{} → {} ({})",
            format::mark_short(series.get("firstPlace").and_then(Json::as_f64)),
            format::mark_short(series.get("lastPlace").and_then(Json::as_f64)),
            match series.get("placeDelta").and_then(Json::as_i64) {
                Some(delta) if delta > 0 => style.paint(&format!("+{} место", delta), GREEN),
                Some(delta) if delta < 0 => style.paint(&format!("{} место", delta), RED),
                _ => style.dim("без изменений"),
            }
        ),
        style.bold("Диаграмма:"),
        sparkline
    );
    println!(
        "  {} {} ({})   {} {} ({})",
        style.bold("Лучшее место:"),
        format::mark_short(series.get("bestPlace").and_then(Json::as_f64)),
        series.get("bestPlaceDate").map(Json::text).unwrap_or_default(),
        style.bold("Средний балл:"),
        format::mark_short(series.get("lastAverage").and_then(Json::as_f64)),
        format!(
            "Δ {}",
            format::delta(
                series.get("lastAverage").and_then(Json::as_f64),
                series.get("firstAverage").and_then(Json::as_f64),
                2
            )
        )
    );
}

/// Расписание на день.
pub fn schedule(lessons: &[Lesson], style: &Style) {
    if lessons.is_empty() {
        println!("{}", style.dim("Уроков нет"));
        return;
    }
    let mut current_date = String::new();
    for lesson in lessons {
        if lesson.date != current_date {
            current_date = lesson.date.clone();
            println!(
                "{} {}",
                style.bold(&format::date_ru(&current_date, true)),
                style.dim(&format::date_short(&current_date))
            );
        }
        let time = match &lesson.begin {
            Some(begin) => match &lesson.end {
                Some(end) => format!("{}–{}", begin, end),
                None => begin.clone(),
            },
            None => "  —  ".to_string(),
        };
        let mark = match lesson.mark {
            Some(value) => style.mark(Some(value), &format!(" {:.0}", value)),
            None => String::new(),
        };
        println!(
            "  {} {} {}{}{}",
            style.dim(&format!("{:>2}", lesson.number.unwrap_or(0))),
            style.dim(&format!("{:<11}", time)),
            lesson.subject,
            if lesson.room.is_empty() { String::new() } else { style.dim(&format!(" · каб. {}", lesson.room)) },
            mark
        );
    }
}

/// Строка «время выполнения» для бенчмарка и диагностики.
pub fn milliseconds(value: f64) -> String {
    if value < 1.0 {
        format!("{:.3} мс", value)
    } else if value < 1000.0 {
        format!("{:.2} мс", value)
    } else {
        format!("{:.2} с", value / 1000.0)
    }
}

/// Отчёт бенчмарка в человекочитаемом виде.
pub fn bench_report(report: &Json, style: &Style) {
    let students = report.get("students").and_then(Json::as_i64).unwrap_or(0);
    let iterations = report.get("iterations").and_then(Json::as_i64).unwrap_or(0);
    println!(
        "{}",
        style.bold(&format!(
            "Бенчмарк ядра: {} учеников, {} итераций",
            students, iterations
        ))
    );
    let timings = report.get("timings").cloned().unwrap_or(Json::obj());
    let rows: [(&str, &str); 7] = [
        ("Построение данных МЭШ", "buildMs"),
        ("Сериализация в JSON", "serializeMs"),
        ("Разбор JSON", "parseMs"),
        ("Таблица рейтинга + сводка", "rankTableMs"),
        ("Сводка по оценкам", "marksSummaryMs"),
        ("Экспорт CSV", "csvMs"),
        ("Описательная статистика", "describeMs"),
    ];
    let width = rows.iter().map(|(label, _)| label.chars().count()).max().unwrap_or(20);
    for (label, key) in rows {
        let value = timings.get(key).and_then(Json::as_f64).unwrap_or(0.0);
        println!("  {} {}", pad(label, width), milliseconds(value));
    }
    let per_second = timings.get("rankTablePerSecond").and_then(Json::as_f64).unwrap_or(0.0);
    println!(
        "{} {} {}",
        style.bold("Пропускная способность:"),
        style.paint(&format!("{:.0} таблиц/с", per_second), GREEN),
        style.dim(&format!("({} строк)", report.get("rows").and_then(Json::as_i64).unwrap_or(0)))
    );
}

/// Отмечает токен в состоянии сессии (для `state` в CLI).
pub fn token_line(state: &Json, style: &Style) {
    let token = state.get("token").cloned().unwrap_or(Json::obj());
    let present = token.get("present").and_then(Json::as_bool).unwrap_or(false);
    println!(
        "{} {}   {} {}",
        style.bold("Токен:"),
        if present {
            style.paint(&token.get("mask").map(Json::text).unwrap_or_default(), GREEN)
        } else {
            style.paint("нет", RED)
        },
        style.bold("Хост:"),
        state.get("host").map(Json::text).unwrap_or_default()
    );
    if let Some(expires) = token.get("expiresAt").and_then(Json::as_i64) {
        println!(
            "  {} {}",
            style.bold("Действует до:"),
            format!("{} ({})", format::date_ru(&util::iso_from_epoch_days(expires / 86_400_000), false), format::relative_time(expires))
        );
    }
}
