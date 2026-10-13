//! Реализация команд CLI: рейтинг, предметы, оценки, задания, расписание,
//! аналитика, история и бенчмарк.

use mesh_core::bridge::{Session, SessionOptions};
use mesh_core::client::RankBoardOptions;
use mesh_core::error::{MeshError, MeshResult};
use mesh_core::format::{self, Column, ColumnFormat};
use mesh_core::insights::{self, Snapshot};
use mesh_core::json::Json;
use mesh_core::marks as marks_lib;
use mesh_core::model::RankBoard;
use mesh_core::util;

use crate::args::Args;
use crate::render::{self, Style};
use crate::{session_from_args, write_text_file};

/// Ученик, для которого строятся отчёты.
pub struct Student {
    pub person_id: String,
    pub student_id: String,
    pub name: String,
}

/// Определяет активного ученика: из параметров, файла авторизации или профиля МЭШ.
pub fn resolve_student(session: &mut Session, args: &Args) -> MeshResult<Student> {
    let person = args.value("person-id").or_else(|| session.active_person_id.clone());
    let student = args.value("student-id");
    if let (Some(person_id), Some(student_id)) = (&person, &student) {
        let name = session.client.name_for(person_id);
        return Ok(Student {
            person_id: person_id.clone(),
            student_id: student_id.clone(),
            name,
        });
    }
    let profile = session.client.profile(false)?;
    let child = match profile.default_child() {
        Some(child) => child.clone(),
        None => return Err(MeshError::new("no-student", "В профиле МЭШ нет учеников")),
    };
    Ok(Student {
        person_id: person.clone().unwrap_or_else(|| child.person_id.clone()),
        student_id: student.clone().unwrap_or_else(|| child.id.clone()),
        name: if child.name.is_empty() { "Ученик".to_string() } else { child.name },
    })
}

fn date_of(args: &Args) -> String {
    args.value("date").unwrap_or_else(util::today_iso)
}

fn period(args: &Args) -> (String, String) {
    let to = args.value("to").unwrap_or_else(util::today_iso);
    let from = args.value("from").unwrap_or_else(|| util::add_days(&to, -30));
    (util::to_iso(&from), util::to_iso(&to))
}

fn top(args: &Args) -> usize {
    match args.number("top") {
        Some(value) if value >= 0 => value as usize,
        _ => 15,
    }
}

fn subject_columns() -> Vec<Column> {
    vec![
        Column::new("name", "Предмет", ColumnFormat::Raw),
        Column::new("average", "Средний балл", ColumnFormat::Mark),
        Column::new("place", "Место", ColumnFormat::Place),
        Column::new("trend", "Тренд", ColumnFormat::Raw),
        Column::new("isExam", "Экзамен", ColumnFormat::Bool),
    ]
}

fn rank_columns() -> Vec<Column> {
    vec![
        Column::new("place", "Место", ColumnFormat::Place),
        Column::new("name", "Ученик", ColumnFormat::Raw),
        Column::new("average", "Средний балл", ColumnFormat::Mark),
        Column::new("previousAverage", "Было", ColumnFormat::Mark),
        Column::new("averageDelta", "Δ балла", ColumnFormat::Mark),
        Column::new("trendDirection", "Тренд", ColumnFormat::Trend),
        Column::new("status", "Статус", ColumnFormat::Raw),
    ]
}

fn mark_columns() -> Vec<Column> {
    vec![
        Column::new("date", "Дата", ColumnFormat::Date),
        Column::new("subjectName", "Предмет", ColumnFormat::Raw),
        Column::new("value", "Оценка", ColumnFormat::Mark),
        Column::new("weight", "Вес", ColumnFormat::Raw),
        Column::new("controlForm", "Форма контроля", ColumnFormat::Raw),
        Column::new("comment", "Комментарий", ColumnFormat::Raw),
    ]
}

fn print_json(value: &Json) {
    println!("{}", value.to_json_pretty());
}

fn fail(message: &str) -> i32 {
    eprintln!("{}", message);
    1
}

fn report_error(error: &MeshError, style: &Style) -> i32 {
    eprintln!(
        "{} {}",
        style.paint("Ошибка:", "\u{1b}[91m"),
        error.describe()
    );
    eprintln!("{}", style.dim(&format!("код: {} · {}", error.code, error.message)));
    1
}

/// Общая точка входа команд, которым нужен МЭШ.
fn with_session<F>(args: &Args, run: F) -> i32
where
    F: FnOnce(&mut Session, &Style) -> MeshResult<i32>,
{
    let style = Style::from_flags(args.has("no-color"));
    let mut session = match session_from_args(args) {
        Ok(session) => session,
        Err(error) => return report_error(&error, &style),
    };
    let result = run(&mut session, &style);
    session.flush();
    match result {
        Ok(code) => code,
        Err(error) => report_error(&error, &style),
    }
}

// ------------------------------------------------------------------ рейтинг --

/// `mesh-rank rank` — рейтинг класса (общий и/или по предметам).
pub fn rank(args: &Args) -> i32 {
    let json_output = args.has("json");
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let date = date_of(args);
        let subjects = session.client.subjects(&student.person_id, &date)?;

        let requested = args.values("subject");
        let selections: Vec<(Option<String>, Option<String>)> = if !requested.is_empty() {
            let mut out: Vec<(Option<String>, Option<String>)> = Vec::new();
            for id in &requested {
                let known = subjects.iter().find(|subject| &subject.id == id || subject.name.eq_ignore_ascii_case(id));
                match known {
                    Some(subject) => out.push((Some(subject.id.clone()), Some(subject.name.clone()))),
                    None => out.push((Some(id.clone()), None)),
                }
            }
            out
        } else if args.has("all") {
            subjects
                .iter()
                .map(|subject| (Some(subject.id.clone()), Some(subject.name.clone())))
                .collect()
        } else {
            vec![(None, None)]
        };

        let mut boards: Vec<RankBoard> = Vec::new();
        for (subject_id, subject_name) in &selections {
            let mut options = RankBoardOptions::new(&student.person_id, &date);
            options.subject_id = subject_id.clone();
            options.subject_name = subject_name.clone();
            options.with_names = !args.has("no-names");
            options.use_cache = !args.has("no-cache");
            let board = session.client.rank_board(options)?;
            if args.has("save-history") {
                save_snapshot(session, &student, &board)?;
            }
            boards.push(board);
        }

        if json_output {
            let payload = if boards.len() == 1 {
                boards[0].to_json()
            } else {
                Json::Arr(boards.iter().map(|board| board.to_json()).collect())
            };
            print_json(&payload);
            return Ok(0);
        }

        if args.has("csv") {
            let mut out = String::new();
            for (index, board) in boards.iter().enumerate() {
                if index > 0 {
                    out.push_str("\r\n");
                }
                let rows: Vec<Json> = board.rows.iter().map(|row| row.to_json()).collect();
                let title = board
                    .subject_name
                    .clone()
                    .unwrap_or_else(|| "Общий рейтинг".to_string());
                out.push_str(&format::to_csv(&rows, &rank_columns(), Some(title.as_str()), ';', index == 0));
            }
            return Ok(write_or_print(args, &out));
        }

        println!(
            "{} · {} · {}",
            style.bold(&student.name),
            format::date_ru(&date, true),
            style.dim(&session.client.base_url.clone())
        );
        for board in &boards {
            render::title(
                &format!(
                    "{}: класс {} · {} · {}",
                    board.subject_name.clone().unwrap_or_else(|| "Общий рейтинг".to_string()),
                    board.summary.total,
                    format::mark_short(board.summary.class_average),
                    format::students_count(board.summary.total as i64),
                ),
                style,
            );
            render::rank_table(&board.rows, style, top(args), true);
            render::rank_summary(&board.summary, style);
        }
        if !selections.iter().any(|(id, _)| id.is_none()) && selections.len() > 1 {
            render::title("Сравнение предметов", style);
            let rows: Vec<Json> = boards
                .iter()
                .map(|board| {
                    Json::object(vec![
                        ("subjectId", Json::str(board.subject_id.clone().unwrap_or_default())),
                        ("name", Json::str(board.subject_name.clone().unwrap_or_default())),
                        ("average", Json::num(board.summary.my_average)),
                        ("place", Json::int(board.summary.my_place)),
                        ("trend", Json::Num(board.summary.my_trend as f64)),
                        ("isExam", Json::Bool(false)),
                    ])
                })
                .collect();
            println!("{}", format::to_text_table(&rows, &subject_columns(), 32));
        }
        Ok(0)
    })
}

// ----------------------------------------------------------------- предметы --

/// `mesh-rank subjects` — предметы со средним баллом и местом.
pub fn subjects(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let date = date_of(args);
        let list = session.client.subjects(&student.person_id, &date)?;
        if args.has("json") {
            print_json(&Json::Arr(list.iter().map(|subject| subject.to_json()).collect()));
            return Ok(0);
        }
        render::title(
            &format!("Предметы · {} · {}", student.name, format::date_ru(&date, false)),
            style,
        );
        render::subjects_table(&list, style);
        let rows: Vec<Json> = list.iter().map(|subject| subject.to_json()).collect();
        if args.has("csv") {
            let csv = format::to_csv(&rows, &subject_columns(), Some("Предметы"), ';', true);
            return Ok(write_or_print(args, &csv));
        }
        Ok(0)
    })
}

// ------------------------------------------------------------------- оценки --

/// `mesh-rank marks` — оценки за период и сводка.
pub fn marks(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let (from, to) = period(args);
        let list = session.client.marks(&student.student_id, &from, &to)?;
        let summary = marks_lib::summarize_marks(&list);
        if args.has("json") {
            print_json(&Json::object(vec![
                ("from", Json::str(from)),
                ("to", Json::str(to)),
                (
                    "marks",
                    Json::Arr(list.iter().map(|mark| mark.to_json()).collect()),
                ),
                ("summary", summary.to_json()),
            ]));
            return Ok(0);
        }
        render::title(
            &format!(
                "Оценки · {} · {}",
                student.name,
                format::date_range_text(&from, &to)
            ),
            style,
        );
        render::marks_summary(&summary, style);
        if args.has("csv") {
            let rows: Vec<Json> = list.iter().map(|mark| mark.to_json()).collect();
            let csv = format::to_csv(&rows, &mark_columns(), Some("Оценки"), ';', true);
            return Ok(write_or_print(args, &csv));
        }
        if args.has("all") {
            render::title("Все оценки", style);
            let rows: Vec<Json> = list.iter().map(|mark| mark.to_json()).collect();
            println!("{}", format::to_text_table(&rows, &mark_columns(), 40));
        }
        Ok(0)
    })
}

// ----------------------------------------------------------- домашние задания --

/// `mesh-rank homeworks` — задания и разбор дедлайнов.
pub fn homeworks(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let (from, to) = period(args);
        let items = session.client.homeworks(&student.student_id, &from, &to)?;
        let report = insights::deadlines(&items, &util::today_iso());
        if args.has("json") {
            print_json(&Json::object(vec![
                ("from", Json::str(from)),
                ("to", Json::str(to)),
                (
                    "homeworks",
                    Json::Arr(items.iter().map(|item| item.to_json()).collect()),
                ),
                ("deadlines", report),
            ]));
            return Ok(0);
        }
        render::title(
            &format!(
                "Домашние задания · {} · {}",
                student.name,
                format::date_range_text(&from, &to)
            ),
            style,
        );
        render::deadlines(&report, style);
        Ok(0)
    })
}

// --------------------------------------------------------------- расписание --

/// `mesh-rank schedule` — расписание на день или диапазон.
pub fn schedule(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let date = date_of(args);
        let to = args.value("to");
        let lessons = session.client.schedule(&student.student_id, &date, to.as_deref())?;
        if args.has("json") {
            print_json(&Json::object(vec![
                ("date", Json::str(date)),
                (
                    "lessons",
                    Json::Arr(lessons.iter().map(|lesson| lesson.to_json()).collect()),
                ),
            ]));
            return Ok(0);
        }
        render::title(
            &format!("Расписание · {}", student.name),
            style,
        );
        render::schedule(&lessons, style);
        Ok(0)
    })
}

// ---------------------------------------------------------------- аналитика --

/// `mesh-rank insights` — прогноз до цели, влияние оценок, дедлайны и динамика.
pub fn insights_command(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let student = resolve_student(session, args)?;
        let (from, to) = {
            let to = args.value("to").unwrap_or_else(util::today_iso);
            let from = args
                .value("from")
                .unwrap_or_else(|| util::school_year_start(&to));
            (util::to_iso(&from), util::to_iso(&to))
        };
        let target = args.float("target").unwrap_or(4.5);
        let remaining = args.number("remaining").unwrap_or(1).max(1);

        let list = session.client.marks(&student.student_id, &from, &to)?;
        let plan = insights::forecast(&list, target, remaining);
        let impact = insights::subject_impact(&list, 5);
        let homeworks = session.client.homeworks(&student.student_id, &to, &to)?;
        let deadline_report = insights::deadlines(&homeworks, &util::today_iso());
        let series = match session.history.as_ref() {
            Some(store) => insights::history_series(&store.snapshots, None),
            None => insights::history_series(&[], None),
        };

        if args.has("json") {
            print_json(&Json::object(vec![
                ("from", Json::str(from)),
                ("to", Json::str(to)),
                ("target", Json::Num(target)),
                ("remaining", Json::Num(remaining as f64)),
                ("forecast", plan),
                ("impact", impact),
                ("deadlines", deadline_report),
                ("history", series),
            ]));
            return Ok(0);
        }

        render::title(
            &format!(
                "Аналитика · {} · {}",
                student.name,
                format::date_range_text(&from, &to)
            ),
            style,
        );
        render::forecast(&plan, style);
        let rows = impact.as_arr().map(|items| items.to_vec()).unwrap_or_default();
        if !rows.is_empty() {
            render::title("Что даст следующая «пятёрка»", style);
            let columns = vec![
                Column::new("subjectName", "Предмет", ColumnFormat::Raw),
                Column::new("average", "Средний", ColumnFormat::Mark),
                Column::new("count", "Оценок", ColumnFormat::Raw),
                Column::new("deltaIfFive", "Прирост", ColumnFormat::Mark),
            ];
            println!("{}", format::to_text_table(&rows, &columns, 30));
        }
        render::title("Домашние задания", style);
        render::deadlines(&deadline_report, style);
        render::title("Динамика", style);
        render::history(&series, style);
        Ok(0)
    })
}

// ------------------------------------------------------------------ история --

/// `mesh-rank history add|list|clear` — локальная история снимков рейтинга.
pub fn history(args: &Args) -> i32 {
    let action = args.subcommand().unwrap_or_else(|| "list".to_string());
    with_session(args, |session, style| match action.as_str() {
        "add" => {
            let student = resolve_student(session, args)?;
            let date = date_of(args);
            let mut options = RankBoardOptions::new(&student.person_id, &date);
            options.subject_id = args.values("subject").first().cloned();
            options.with_names = false;
            let board = session.client.rank_board(options)?;
            let snapshot = save_snapshot(session, &student, &board)?;
            if args.has("json") {
                print_json(&snapshot);
            } else {
                println!(
                    "{} {} {} {}",
                    style.bold("Снимок сохранён:"),
                    format::date_ru(&snapshot.date, false),
                    format!("место #{}", snapshot.my_place.unwrap_or(0)),
                    style.mark(snapshot.my_average, &format::mark_short(snapshot.my_average))
                );
            }
            Ok(0)
        }
        "clear" => {
            if let Some(store) = session.history.as_mut() {
                store.clear();
                let _ = store.save();
            }
            println!("{}", style.dim("История очищена"));
            Ok(0)
        }
        _ => {
            let subject = args.values("subject").first().cloned();
            let snapshots = session.history.as_ref().map(|store| store.snapshots.clone()).unwrap_or_default();
            let series = insights::history_series(&snapshots, subject.as_deref());
            if args.has("json") {
                print_json(&series);
                return Ok(0);
            }
            render::title("Динамика рейтинга", style);
            render::history(&series, style);
            if !snapshots.is_empty() {
                let columns = vec![
                    Column::new("date", "Дата", ColumnFormat::Date),
                    Column::new("myPlace", "Место", ColumnFormat::Place),
                    Column::new("myAverage", "Средний", ColumnFormat::Mark),
                    Column::new("classAverage", "Класс", ColumnFormat::Mark),
                    Column::new("total", "В классе", ColumnFormat::Raw),
                ];
                let rows: Vec<Json> = snapshots.iter().map(Snapshot::to_json).collect();
                println!("{}", format::to_text_table(&rows, &columns, 30));
            }
            Ok(0)
        }
    })
}

fn save_snapshot(session: &mut Session, student: &Student, board: &RankBoard) -> MeshResult<Snapshot> {
    let snapshot = Snapshot {
        date: board.date.clone(),
        subject_id: board.subject_id.clone(),
        my_place: board.summary.my_place,
        my_average: board.summary.my_average,
        class_average: board.summary.class_average,
        total: board.summary.total,
        saved_at: Some(util::now_ms()),
    };
    let store = match session.history.as_mut() {
        Some(store) => store,
        None => {
            return Err(MeshError::new(
                "no-history",
                "Локальная история не подключена (задайте --data-dir)",
            ))
        }
    };
    store.append(snapshot.clone());
    let _ = store.save();
    let _ = student;
    Ok(snapshot)
}

// ---------------------------------------------------------------------- CSV --

/// `mesh-rank csv rank|marks` — текст CSV в stdout (с BOM и «;»).
pub fn csv(args: &Args) -> i32 {
    let kind = args.subcommand().unwrap_or_else(|| "rank".to_string());
    with_session(args, |session, _style| {
        let student = resolve_student(session, args)?;
        let text = match kind.as_str() {
            "marks" => {
                let (from, to) = period(args);
                let list = session.client.marks(&student.student_id, &from, &to)?;
                let rows: Vec<Json> = list.iter().map(|mark| mark.to_json()).collect();
                format::to_csv(&rows, &mark_columns(), Some("Оценки"), ';', true)
            }
            "subjects" => {
                let date = date_of(args);
                let list = session.client.subjects(&student.person_id, &date)?;
                let rows: Vec<Json> = list.iter().map(|subject| subject.to_json()).collect();
                format::to_csv(&rows, &subject_columns(), Some("Предметы"), ';', true)
            }
            _ => {
                let date = date_of(args);
                let mut options = RankBoardOptions::new(&student.person_id, &date);
                options.subject_id = args.values("subject").first().cloned();
                let board = session.client.rank_board(options)?;
                let rows: Vec<Json> = board.rows.iter().map(|row| row.to_json()).collect();
                let title = board.subject_name.unwrap_or_else(|| "Общий рейтинг".to_string());
                format::to_csv(&rows, &rank_columns(), Some(title.as_str()), ';', true)
            }
        };
        Ok(write_or_print(args, &text))
    })
}

fn write_or_print(args: &Args, text: &str) -> i32 {
    match args.value("out") {
        Some(path) => match write_text_file(std::path::Path::new(&path), text) {
            Ok(()) => {
                println!("Сохранено: {} ({} байт)", path, text.len());
                0
            }
            Err(error) => fail(&format!("Не удалось записать файл: {}", error)),
        },
        None => {
            let _ = kind;
            print!("{}", text);
            0
        }
    }
}

// ----------------------------------------------------------------- бенчмарк --

/// `mesh-rank bench` — микробенчмарк ядра без сети.
pub fn bench(args: &Args) -> i32 {
    let style = Style::from_flags(args.has("no-color"));
    let params = Json::object(vec![
        ("students", Json::Num(args.number("students").unwrap_or(26) as f64)),
        ("marks", Json::Num(args.number("marks").unwrap_or(200) as f64)),
        ("iterations", Json::Num(args.number("iterations").unwrap_or(200) as f64)),
    ]);
    let mut session = Session::new(SessionOptions::default());
    match session.handle("bench", &params) {
        Ok(report) => {
            if args.has("json") {
                print_json(&report);
            } else {
                render::bench_report(&report, &style);
            }
            0
        }
        Err(error) => report_error(&error, &style),
    }
}

/// `mesh-rank state` — состояние сессии и кэшей.
pub fn state(args: &Args) -> i32 {
    with_session(args, |session, style| {
        let state = session.handle("state", &Json::obj())?;
        if args.has("json") {
            print_json(&state);
            return Ok(0);
        }
        render::title("Состояние сессии", style);
        render::token_line(&state, style);
        println!(
            "{} {}   {} {}",
            style.bold("Кэш имён:"),
            session.client.name_cache().entries.len(),
            style.bold("Запросов:"),
            session.client.request_count
        );
        let cache = session.client.cache_stats();
        println!(
            "{} {} записей (попаданий {}, промахов {})",
            style.bold("Кэш ответов:"),
            cache.get("entries").and_then(Json::as_i64).unwrap_or(0),
            cache.get("hits").and_then(Json::as_i64).unwrap_or(0),
            cache.get("misses").and_then(Json::as_i64).unwrap_or(0)
        );
        if let Some(store) = &session.history {
            println!("{} {} снимков", style.bold("История:"), store.len());
        }
        Ok(0)
    })
}

/// `mesh-rank token` — что ядро думает о токене (без обращения к сети).
pub fn token(args: &Args) -> i32 {
    let style = Style::from_flags(args.has("no-color"));
    let raw = args.value("token").or_else(|| {
        let path = std::path::Path::new("school-mos-ru.json");
        mesh_core::cache::TokenFile::load(path).map(|data| data.token)
    });
    let info = mesh_core::token::describe_token(raw.as_deref(), util::now_ms());
    if args.has("json") {
        print_json(&info);
        return 0;
    }
    render::title("Токен МЭШ", style);
    println!(
        "{} {}",
        style.bold("Тип:"),
        info.get("kind").map(Json::text).unwrap_or_default()
    );
    println!(
        "{} {}",
        style.bold("Маска:"),
        info.get("mask").map(Json::text).unwrap_or_default()
    );
    println!(
        "{} {}",
        style.bold("Длина:"),
        info.get("length").and_then(Json::as_i64).unwrap_or(0)
    );
    match info.get("expiresAt").and_then(Json::as_i64) {
        Some(expires) => println!(
            "{} {}",
            style.bold("Истекает:"),
            format!("{} ({})", format::date_ru(&util::iso_from_epoch_days(expires / 86_400_000), false), format::relative_time(expires))
        ),
        None => println!("{} {}", style.bold("Истекает:"), style.dim("срок не указан")),
    }
    0
}

/// Спектр возможностей: показывается в `help` и в диагностике приложения.
pub fn features() -> Vec<(&'static str, &'static str)> {
    vec![
        ("rank", "рейтинг класса: место, Δ места, средний балл, Δ балла, полосы уровня, сводка и гистограмма"),
        ("subjects", "предметы с местами, средними баллами и признаком экзамена"),
        ("marks", "оценки за период, взвешенный средний, распределение по предметам"),
        ("homeworks", "домашние задания и разбор дедлайнов (просрочено/сегодня/завтра/неделя)"),
        ("schedule", "расписание на день или неделю"),
        ("insights", "прогноз до целевого среднего, влияние оценок, динамика, дедлайны"),
        ("history", "локальные снимки рейтинга: добавить, показать, очистить"),
        ("csv", "экспорт рейтинга/оценок/предметов в CSV (BOM + «;» — Excel открывает сразу)"),
        ("bench", "микробенчмарк ядра: разбор, таблица рейтинга, сводка, CSV"),
        ("serve", "мост JSON-lines для Node/Electron (приложение использует нативное ядро)"),
        ("token", "разбор токена: тип, маска, срок действия"),
        ("selftest", "самопроверка ядра без сети (12 проверок)"),
    ]
}
