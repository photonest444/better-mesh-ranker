//! Терпимый разбор ответов МЭШ: разные подсистемы отдают поля по-разному,
//! поэтому всюду используется «первое непустое из списка ключей».
//!
//! Полный порт соответствующих функций `shared/core/mesh-core.js`.

use crate::json::Json;
use crate::model::{Child, Homework, Lesson, Mark, Parent, Profile, RankMember, Subject};
use crate::util;

/// «Демидов Пётр Сергеевич» — склейка непустых частей ФИО.
pub fn person_name(parts: &[&str]) -> String {
    let mut chunks: Vec<String> = Vec::new();
    for part in parts {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            chunks.push(trimmed.to_string());
        }
    }
    chunks.join(" ")
}

fn text(value: &Json, keys: &[&str]) -> String {
    value.pick_text(keys)
}

/// Список элементов из ответа: массив, `payload`, `items`, `lessons` или `data`.
pub fn payload_list(data: &Json) -> Vec<Json> {
    match data {
        Json::Null => Vec::new(),
        Json::Arr(items) => items.clone(),
        Json::Obj(_) => {
            for key in ["payload", "items", "lessons", "data"] {
                if let Some(value) = data.get(key) {
                    match value {
                        Json::Arr(items) => return items.clone(),
                        Json::Obj(_) => return vec![value.clone()],
                        _ => continue,
                    }
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Оценки могут лежать в `payload`, `marks` или `items`.
pub fn marks_payload(data: &Json) -> Vec<Json> {
    match data {
        Json::Null => Vec::new(),
        Json::Arr(items) => items.clone(),
        Json::Obj(_) => {
            for key in ["payload", "marks", "items"] {
                if let Some(value) = data.get(key) {
                    if let Json::Arr(items) = value {
                        return items.clone();
                    }
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

pub fn normalize_child(raw: &Json) -> Child {
    let last = text(raw, &["last_name", "lastName"]);
    let first = text(raw, &["first_name", "firstName"]);
    let middle = text(raw, &["middle_name", "middleName"]);
    let name = person_name(&[&last, &first, &middle]);
    let fallback_name = text(raw, &["name"]);
    let short = if first.is_empty() { fallback_name.clone() } else { first.clone() };
    Child {
        id: text(raw, &["id", "user_id", "student_id"]),
        person_id: text(raw, &["contingent_guid", "person_id", "personId"]),
        name: if name.is_empty() {
            if fallback_name.is_empty() {
                "Ученик".to_string()
            } else {
                fallback_name.clone()
            }
        } else {
            name
        },
        short_name: if short.is_empty() { "Ученик".to_string() } else { short },
        class_id: text(raw, &["class_id", "classId"]),
        class_name: text(raw, &["class_name", "className"]),
        school_id: text(raw, &["school_id", "schoolId"]),
        school_name: text(raw, &["school_name", "schoolName"]),
        avatar_url: text(raw, &["avatar_url", "avatarUrl"]),
    }
}

pub fn normalize_profile(data: &Json) -> Profile {
    let raw_parent = data.get("profile").cloned().unwrap_or(Json::Null);
    let parent_name = person_name(&[
        &text(&raw_parent, &["last_name", "lastName"]),
        &text(&raw_parent, &["first_name", "firstName"]),
        &text(&raw_parent, &["middle_name", "middleName"]),
    ]);
    let mut children: Vec<Child> = Vec::new();
    if let Some(items) = data.get("children").and_then(Json::as_arr) {
        for item in items {
            children.push(normalize_child(item));
        }
    }
    Profile {
        parent: Parent {
            id: text(&raw_parent, &["id", "user_id"]),
            name: if parent_name.is_empty() { "Родитель".to_string() } else { parent_name },
            email: text(&raw_parent, &["email"]),
            phone: text(&raw_parent, &["phone", "mobile_phone"]),
        },
        children,
        hash: text(data, &["hash"]),
    }
}

pub fn normalize_subject(raw: &Json) -> Subject {
    let rank = raw.get("rank").cloned().unwrap_or(Json::Null);
    let average = rank
        .pick_num(&["averageMarkFive"])
        .or_else(|| raw.pick_num(&["averageMarkFive", "average_mark"]));
    let place = rank
        .pick_int(&["rankPlace", "place"])
        .or_else(|| raw.pick_int(&["rankPlace"]));
    Subject {
        id: text(raw, &["subjectId", "subject_id", "id"]),
        name: if text(raw, &["subjectName", "subject_name", "name"]).is_empty() {
            "Предмет".to_string()
        } else {
            text(raw, &["subjectName", "subject_name", "name"])
        },
        average,
        place,
        status: text(&rank, &["rankStatus"]),
        trend: text(&rank, &["trend"]),
        is_exam: raw
            .pick(&["isExam", "is_exam"])
            .and_then(Json::as_bool)
            .unwrap_or(false),
    }
}

/// Строка рейтинга: `{personId, rank:{averageMarkFive, rankPlace, rankStatus, trend}, previousRank:{…}}`.
pub fn normalize_rank_member(raw: &Json, index: usize) -> RankMember {
    let rank = raw.get("rank").cloned().unwrap_or(Json::Null);
    let previous = raw
        .get("previousRank")
        .or_else(|| raw.get("previous_rank"))
        .cloned()
        .unwrap_or(Json::Null);
    let average = rank
        .pick_num(&["averageMarkFive", "average_mark"])
        .or_else(|| raw.pick_num(&["averageMarkFive"]));
    let previous_average = previous.pick_num(&["averageMarkFive", "average_mark"]);
    let place = rank.pick_int(&["rankPlace", "place"]);
    let previous_place = previous.pick_int(&["rankPlace", "place"]);
    let place_delta = match (place, previous_place) {
        (Some(current), Some(previous)) => Some(previous - current),
        _ => None,
    };
    let average_delta = match (average, previous_average) {
        (Some(current), Some(previous)) => Some(util::round(current - previous, 2)),
        _ => None,
    };
    RankMember {
        index,
        person_id: text(raw, &["personId", "person_id"]),
        image_id: text(raw, &["imageId", "image_id"]),
        place: Some(place.unwrap_or(index as i64 + 1)),
        average,
        status: text(&rank, &["rankStatus"]),
        trend: text(&rank, &["trend"]),
        previous_place,
        previous_average,
        place_delta,
        average_delta,
    }
}

pub fn normalize_mark(raw: &Json) -> Mark {
    let control = {
        let value = text(raw, &["control_form_name", "controlForm", "form_name"]);
        if value.is_empty() {
            "—".to_string()
        } else {
            value
        }
    };
    let subject = {
        let value = text(raw, &["subject_name", "subjectName"]);
        if value.is_empty() {
            "—".to_string()
        } else {
            value
        }
    };
    let weight = raw.pick_num(&["weight"]).unwrap_or(1.0);
    let date_raw = raw.pick_text(&["created_at", "date"]);
    Mark {
        id: text(raw, &["id", "mark_id"]),
        value: raw.pick_num(&["value", "mark"]),
        subject_id: text(raw, &["subject_id", "subjectId"]),
        subject_name: subject,
        control_form: control,
        weight: if weight > 0.0 { weight } else { 1.0 },
        date: util::to_iso(&date_raw),
        comment: text(raw, &["comment"]),
        is_exam: raw
            .pick(&["is_exam", "isExam"])
            .and_then(Json::as_bool)
            .unwrap_or(false),
    }
}

pub fn normalize_homework(raw: &Json) -> Homework {
    let subject = {
        let value = text(raw, &["subject_name", "subjectName"]);
        if value.is_empty() {
            "—".to_string()
        } else {
            value
        }
    };
    // Ключи «сырого» ответа МЭШ и уже нормализованных объектов JS-ядра:
    // мост принимает и то и другое (нужно для ускорителя из браузера/Electron).
    let due_raw = text(raw, &["date_prepared", "deadline", "due_date", "dueDate"]);
    let due_date = if due_raw.trim().is_empty() {
        None
    } else {
        Some(util::to_iso(&due_raw))
    };
    let assigned_raw = text(raw, &["date_assigned_on", "date", "assignedOn"]);
    let attachments = match raw.get("attachments").or_else(|| raw.get("files")) {
        Some(Json::Arr(items)) => items.clone(),
        _ => Vec::new(),
    };
    Homework {
        id: text(raw, &["homework_entry_student_id", "homework_id", "id"]),
        subject_id: text(raw, &["subject_id", "subjectId"]),
        subject_name: subject,
        description: text(raw, &["description", "text", "homework"]),
        assigned_on: util::to_iso(&assigned_raw),
        due_date,
        is_done: raw
            .pick(&["is_done", "isDone"])
            .and_then(Json::as_bool)
            .unwrap_or(false),
        attachments,
    }
}

/// Расписание: формат ответа отличается между регионами, поэтому собираем уроки
/// из всех известных вариантов структуры и сортируем по дате/времени/номеру.
pub fn normalize_schedule(data: &Json) -> Vec<Lesson> {
    let mut lessons: Vec<Lesson> = Vec::new();
    for entry in payload_list(data) {
        let day_iso = text(&entry, &["date", "day", "date_from"]);
        let nested = entry
            .get("lessons")
            .or_else(|| entry.get("lesson_list"))
            .or_else(|| entry.get("items"))
            .or_else(|| entry.get("schedule"));
        match nested {
            Some(Json::Arr(items)) => {
                for item in items {
                    push_lesson(&mut lessons, item, &day_iso);
                }
            }
            Some(Json::Obj(entries)) => {
                for (key, group) in entries {
                    match group {
                        Json::Arr(items) => {
                            for item in items {
                                push_lesson(&mut lessons, item, key);
                            }
                        }
                        other => push_lesson(&mut lessons, other, key),
                    }
                }
            }
            _ => push_lesson(&mut lessons, &entry, &day_iso),
        }
    }
    lessons.sort_by(|a, b| {
        if a.date != b.date {
            return a.date.cmp(&b.date);
        }
        match (&a.begin, &b.begin) {
            (Some(left), Some(right)) if left != right => return left.cmp(right),
            _ => {}
        }
        let left = a.number.unwrap_or(0);
        let right = b.number.unwrap_or(0);
        left.cmp(&right)
    });
    lessons
}

fn push_lesson(lessons: &mut Vec<Lesson>, item: &Json, day_iso: &str) {
    if !item.is_obj() {
        return;
    }
    let begin = text(item, &["begin_time", "start_time", "startTime", "time_from", "time"]);
    let end = text(item, &["end_time", "finish_time", "endTime", "time_to"]);
    let date_raw = text(item, &["date", "day"]);
    let date = if !date_raw.trim().is_empty() {
        util::to_iso(&date_raw)
    } else if !day_iso.trim().is_empty() {
        util::to_iso(day_iso)
    } else {
        util::today_iso()
    };
    let subject_raw = text(item, &["subject_name", "subjectName"]);
    let subject_name = if !subject_raw.is_empty() {
        subject_raw
    } else {
        item.get_path("subject.name").map(Json::text).unwrap_or_default()
    };
    let teacher_raw = text(item, &["teacher_name", "teacherName"]);
    let teacher = if !teacher_raw.is_empty() {
        teacher_raw
    } else {
        item.get_path("teacher.fio").map(Json::text).unwrap_or_default()
    };
    let room_raw = text(item, &["room_name", "room", "cabinet"]);
    let room = if !room_raw.is_empty() {
        room_raw
    } else {
        item.get_path("room.name").map(Json::text).unwrap_or_default()
    };
    lessons.push(Lesson {
        date,
        number: item.pick_int(&["lesson_number", "number", "lessonNumber"]),
        begin: short_time(&begin),
        end: short_time(&end),
        subject: if subject_name.is_empty() { "—".to_string() } else { subject_name },
        teacher,
        room,
        homework: text(item, &["homework", "home_task", "description"]),
        mark: item.pick_num(&["mark", "mark_value"]),
        is_cancelled: item
            .pick(&["is_cancel", "isCancelled"])
            .and_then(Json::as_bool)
            .unwrap_or(false),
    });
}

fn short_time(value: &str) -> Option<String> {
    if value.trim().is_empty() {
        return None;
    }
    Some(util::chars_take(value.trim(), 5))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homework_accepts_js_normalized_shape() {
        // Так выглядит задание после JS-нормализатора (camelCase).
        let raw = Json::parse(
            r#"{"id":"h1","subjectId":"s1","subjectName":"Физика","description":"Параграф 12",
                "assignedOn":"2026-10-10","dueDate":"2026-10-14","isDone":false}"#,
        )
        .expect("json");
        let homework = normalize_homework(&raw);
        assert_eq!(homework.id, "h1");
        assert_eq!(homework.subject_name, "Физика");
        assert_eq!(homework.due_date.as_deref(), Some("2026-10-14"));
        assert_eq!(homework.assigned_on, "2026-10-10");
        assert!(!homework.is_done);
    }

    #[test]
    fn profile_is_normalized() {
        let data = Json::parse(
            r#"{"profile":{"id":1,"last_name":"Демидова","first_name":"Ольга","middle_name":"Сергеевна"},
                "children":[{"id":42,"contingent_guid":"uuid-1","last_name":"Демидов","first_name":"Пётр","class_name":"7 «Б»"}]}"#,
        )
        .expect("json");
        let profile = normalize_profile(&data);
        assert_eq!(profile.parent.name, "Демидова Ольга Сергеевна");
        assert_eq!(profile.children.len(), 1);
        assert_eq!(profile.children[0].id, "42");
        assert_eq!(profile.children[0].person_id, "uuid-1");
        assert_eq!(profile.children[0].name, "Демидов Пётр");
        assert_eq!(profile.default_child().map(|c| c.id.as_str()), Some("42"));
    }

    #[test]
    fn rank_member_deltas() {
        let raw = Json::parse(
            r#"{"personId":"x","rank":{"averageMarkFive":4.75,"rankPlace":3,"rankStatus":"TOP","trend":"+0.25"},
                "previousRank":{"averageMarkFive":4.5,"rankPlace":5}}"#,
        )
        .expect("json");
        let member = normalize_rank_member(&raw, 0);
        assert_eq!(member.place, Some(3));
        assert_eq!(member.average, Some(4.75));
        assert_eq!(member.place_delta, Some(2));
        assert_eq!(member.average_delta, Some(0.25));
    }

    #[test]
    fn marks_homeworks_and_schedule() {
        let mark = normalize_mark(
            &Json::parse(
                r#"{"id":7,"value":5,"subject_id":3,"subject_name":"Русский язык",
                    "control_form_name":"Диктант","weight":2,"created_at":"2026-10-05 12:00:00","is_exam":false}"#,
            )
            .expect("json"),
        );
        assert_eq!(mark.value, Some(5.0));
        assert_eq!(mark.date, "2026-10-05");
        assert_eq!(mark.weight, 2.0);

        let homework = normalize_homework(
            &Json::parse(
                r#"{"homework_entry_student_id":"h1","subject_name":"История","description":"Параграф 12",
                    "date_assigned_on":"2026-10-06","date_prepared":"2026-10-09","is_done":true}"#,
            )
            .expect("json"),
        );
        assert!(homework.is_done);
        assert_eq!(homework.assigned_on, "2026-10-06");
        assert_eq!(homework.due_date.as_deref(), Some("2026-10-09"));

        let schedule = normalize_schedule(
            &Json::parse(
                r#"{"payload":[{"date":"2026-10-06","lessons":[
                    {"lesson_number":1,"begin_time":"08:30:00","subject_name":"Алгебра","room_name":"204","teacher_name":"Соколова И. П."},
                    {"lesson_number":2,"start_time":"09:25","subjectName":"Геометрия","room":"211"}]},
                    {"lesson_number":3,"begin_time":"10:30","subject_name":"Физика"}]}"#,
            )
            .expect("json"),
        );
        assert_eq!(schedule.len(), 3);
        assert_eq!(schedule[0].begin.as_deref(), Some("08:30"));
        assert_eq!(schedule[0].subject, "Алгебра");
        assert_eq!(schedule[0].room, "204");
        assert_eq!(schedule[1].subject, "Геометрия");
        assert_eq!(schedule[2].date, util::today_iso());
    }

    #[test]
    fn schedule_days_keyed_by_date() {
        let schedule = normalize_schedule(
            &Json::parse(
                r#"{"payload":{"2026-10-07":[{"lesson_number":1,"begin_time":"08:30","subject_name":"Химия"}]}}"#,
            )
            .expect("json"),
        );
        assert_eq!(schedule.len(), 1);
        assert_eq!(schedule[0].date, "2026-10-07");
        assert_eq!(schedule[0].subject, "Химия");
    }
}
