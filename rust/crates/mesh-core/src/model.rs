//! Модель данных МЭШ в нормализованном виде + сериализация в тот же JSON,
//! который отдаёт JS-ядро (важно для общего интерфейса и для моста в Node).

use crate::json::Json;

/// Ребёнок из профиля родителя.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Child {
    pub id: String,
    pub person_id: String,
    pub name: String,
    pub short_name: String,
    pub class_id: String,
    pub class_name: String,
    pub school_id: String,
    pub school_name: String,
    pub avatar_url: String,
}

impl Child {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("id", Json::str(self.id.clone())),
            ("personId", Json::str(self.person_id.clone())),
            ("name", Json::str(self.name.clone())),
            ("shortName", Json::str(self.short_name.clone())),
            ("classId", Json::str(self.class_id.clone())),
            ("className", Json::str(self.class_name.clone())),
            ("schoolId", Json::str(self.school_id.clone())),
            ("schoolName", Json::str(self.school_name.clone())),
            ("avatarUrl", Json::str(self.avatar_url.clone())),
        ])
    }
}

/// Профиль родителя.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parent {
    pub id: String,
    pub name: String,
    pub email: String,
    pub phone: String,
}

impl Parent {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("id", Json::str(self.id.clone())),
            ("name", Json::str(self.name.clone())),
            ("email", Json::str(self.email.clone())),
            ("phone", Json::str(self.phone.clone())),
        ])
    }
}

/// Профиль вместе с детьми (ответ `/api/family/web/v1/profile`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Profile {
    pub parent: Parent,
    pub children: Vec<Child>,
    pub hash: String,
}

impl Profile {
    pub fn default_child(&self) -> Option<&Child> {
        self.children.first()
    }

    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("parent", self.parent.to_json()),
            ("children", Json::Arr(self.children.iter().map(Child::to_json).collect())),
            (
                "defaultChild",
                match self.default_child() {
                    Some(child) => child.to_json(),
                    None => Json::Null,
                },
            ),
            ("hash", Json::str(self.hash.clone())),
        ])
    }
}

/// Предмет с местом и средним баллом ученика.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subject {
    pub id: String,
    pub name: String,
    pub average: Option<f64>,
    pub place: Option<i64>,
    pub status: String,
    pub trend: String,
    pub is_exam: bool,
}

impl Subject {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("id", Json::str(self.id.clone())),
            ("name", Json::str(self.name.clone())),
            ("average", Json::num(self.average)),
            ("place", Json::int(self.place)),
            ("status", Json::str(self.status.clone())),
            ("trend", Json::str(self.trend.clone())),
            ("isExam", Json::Bool(self.is_exam)),
        ])
    }
}

/// Строка рейтинга до добавления имён (сырой участник).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RankMember {
    pub index: usize,
    pub person_id: String,
    pub image_id: String,
    pub place: Option<i64>,
    pub average: Option<f64>,
    pub status: String,
    pub trend: String,
    pub previous_place: Option<i64>,
    pub previous_average: Option<f64>,
    pub place_delta: Option<i64>,
    pub average_delta: Option<f64>,
}

/// Готовая строка таблицы рейтинга (то, что показывает интерфейс).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RankRow {
    pub index: usize,
    pub person_id: String,
    pub image_id: String,
    pub place: Option<i64>,
    pub average: Option<f64>,
    pub status: String,
    pub trend: String,
    pub previous_place: Option<i64>,
    pub previous_average: Option<f64>,
    pub place_delta: Option<i64>,
    pub average_delta: Option<f64>,
    pub name: String,
    pub is_me: bool,
    pub color: String,
    pub trend_direction: i32,
    pub rank_label: String,
}

impl RankRow {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("index", Json::Num(self.index as f64)),
            ("personId", Json::str(self.person_id.clone())),
            ("imageId", Json::str(self.image_id.clone())),
            ("place", Json::int(self.place)),
            ("average", Json::num(self.average)),
            ("status", Json::str(self.status.clone())),
            ("trend", Json::str(self.trend.clone())),
            ("previousPlace", Json::int(self.previous_place)),
            ("previousAverage", Json::num(self.previous_average)),
            ("placeDelta", Json::int(self.place_delta)),
            ("averageDelta", Json::num(self.average_delta)),
            ("name", Json::str(self.name.clone())),
            ("isMe", Json::Bool(self.is_me)),
            ("color", Json::str(self.color.clone())),
            ("trendDirection", Json::Num(self.trend_direction as f64)),
            ("rankLabel", Json::str(self.rank_label.clone())),
        ])
    }
}

/// Сводка по рейтингу класса (KPI-плитки).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RankSummary {
    pub total: usize,
    pub with_marks: usize,
    pub class_average: Option<f64>,
    pub class_median: Option<f64>,
    pub class_min: Option<f64>,
    pub class_max: Option<f64>,
    pub my_average: Option<f64>,
    pub my_place: Option<i64>,
    pub my_trend: i32,
    pub my_delta: Option<f64>,
    pub best_place: Option<i64>,
    pub worst_place: Option<i64>,
    pub above_class_average: Option<bool>,
    pub ahead_of_me: Option<i64>,
    pub behind_me: Option<i64>,
    pub gap_to_leader: Option<f64>,
    pub gap_to_next: Option<f64>,
    pub leader: Option<RankRow>,
    pub my_row: Option<RankRow>,
    /// Средние баллы, по которым построена гистограмма (в JSON не попадают напрямую).
    pub averages: Vec<f64>,
}

impl RankSummary {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("total", Json::Num(self.total as f64)),
            ("withMarks", Json::Num(self.with_marks as f64)),
            ("classAverage", Json::num(self.class_average)),
            ("classMedian", Json::num(self.class_median)),
            ("classMin", Json::num(self.class_min)),
            ("classMax", Json::num(self.class_max)),
            ("myAverage", Json::num(self.my_average)),
            ("myPlace", Json::int(self.my_place)),
            ("myRow", match &self.my_row {
                Some(row) => row.to_json(),
                None => Json::Null,
            }),
            ("myTrend", Json::Num(self.my_trend as f64)),
            ("myDelta", Json::num(self.my_delta)),
            (
                "leader",
                match &self.leader {
                    Some(row) => Json::object(vec![
                        ("name", Json::str(row.name.clone())),
                        ("average", Json::num(row.average)),
                        ("personId", Json::str(row.person_id.clone())),
                    ]),
                    None => Json::Null,
                },
            ),
            ("gapToLeader", Json::num(self.gap_to_leader)),
            ("gapToNext", Json::num(self.gap_to_next)),
            ("aheadOfMe", Json::int(self.ahead_of_me)),
            ("behindMe", Json::int(self.behind_me)),
            (
                "aboveClassAverage",
                match self.above_class_average {
                    Some(value) => Json::Bool(value),
                    None => Json::Null,
                },
            ),
            ("bestPlace", Json::int(self.best_place)),
            ("worstPlace", Json::int(self.worst_place)),
            (
                "histogram",
                Json::Arr(
                    crate::stats::histogram(&self.averages, 2.0, 5.0, 0.5)
                        .iter()
                        .map(|bucket| bucket.to_json())
                        .collect(),
                ),
            ),
        ])
    }
}

/// Оценка.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mark {
    pub id: String,
    pub value: Option<f64>,
    pub subject_id: String,
    pub subject_name: String,
    pub control_form: String,
    pub weight: f64,
    pub date: String,
    pub comment: String,
    pub is_exam: bool,
}

impl Mark {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("id", Json::str(self.id.clone())),
            ("value", Json::num(self.value)),
            ("subjectId", Json::str(self.subject_id.clone())),
            ("subjectName", Json::str(self.subject_name.clone())),
            ("controlForm", Json::str(self.control_form.clone())),
            ("weight", Json::Num(self.weight)),
            ("date", Json::str(self.date.clone())),
            ("comment", Json::str(self.comment.clone())),
            ("isExam", Json::Bool(self.is_exam)),
        ])
    }
}

/// Сводка по предмету внутри сводки оценок.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubjectMarksSummary {
    pub subject_id: String,
    pub subject_name: String,
    pub count: usize,
    pub average: Option<f64>,
    pub median: Option<f64>,
    pub color: String,
    pub marks: Vec<Mark>,
}

impl SubjectMarksSummary {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("subjectId", Json::str(self.subject_id.clone())),
            ("subjectName", Json::str(self.subject_name.clone())),
            ("count", Json::Num(self.count as f64)),
            ("average", Json::num(self.average)),
            ("median", Json::num(self.median)),
            ("color", Json::str(self.color.clone())),
            ("marks", Json::Arr(self.marks.iter().map(Mark::to_json).collect())),
        ])
    }
}

/// Сводка по оценкам за период.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarksSummary {
    pub count: usize,
    pub with_value: usize,
    pub average: Option<f64>,
    pub weighted_average: Option<f64>,
    pub median: Option<f64>,
    pub best: Option<f64>,
    pub worst: Option<f64>,
    pub by_subject: Vec<SubjectMarksSummary>,
    pub by_value: Vec<(i64, usize, String)>,
    pub last_mark: Option<Mark>,
}

impl MarksSummary {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("count", Json::Num(self.count as f64)),
            ("withValue", Json::Num(self.with_value as f64)),
            ("average", Json::num(self.average)),
            ("weightedAverage", Json::num(self.weighted_average)),
            ("median", Json::num(self.median)),
            ("best", Json::num(self.best)),
            ("worst", Json::num(self.worst)),
            (
                "bySubject",
                Json::Arr(self.by_subject.iter().map(SubjectMarksSummary::to_json).collect()),
            ),
            (
                "byValue",
                Json::Arr(
                    self.by_value
                        .iter()
                        .map(|(value, count, color)| {
                            Json::object(vec![
                                ("value", Json::Num(*value as f64)),
                                ("count", Json::Num(*count as f64)),
                                ("color", Json::str(color.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "lastMark",
                match &self.last_mark {
                    Some(mark) => mark.to_json(),
                    None => Json::Null,
                },
            ),
        ])
    }
}

/// Домашнее задание.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Homework {
    pub id: String,
    pub subject_id: String,
    pub subject_name: String,
    pub description: String,
    pub assigned_on: String,
    pub due_date: Option<String>,
    pub is_done: bool,
    pub attachments: Vec<Json>,
}

impl Homework {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("id", Json::str(self.id.clone())),
            ("subjectId", Json::str(self.subject_id.clone())),
            ("subjectName", Json::str(self.subject_name.clone())),
            ("description", Json::str(self.description.clone())),
            ("assignedOn", Json::str(self.assigned_on.clone())),
            ("dueDate", Json::text_or_null(&self.due_date)),
            ("isDone", Json::Bool(self.is_done)),
            ("attachments", Json::Arr(self.attachments.clone())),
        ])
    }
}

/// Урок расписания.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Lesson {
    pub date: String,
    pub number: Option<i64>,
    pub begin: Option<String>,
    pub end: Option<String>,
    pub subject: String,
    pub teacher: String,
    pub room: String,
    pub homework: String,
    pub mark: Option<f64>,
    pub is_cancelled: bool,
}

impl Lesson {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("date", Json::str(self.date.clone())),
            ("number", Json::int(self.number)),
            ("begin", Json::text_or_null(&self.begin)),
            ("end", Json::text_or_null(&self.end)),
            ("subject", Json::str(self.subject.clone())),
            ("teacher", Json::str(self.teacher.clone())),
            ("room", Json::str(self.room.clone())),
            ("homework", Json::str(self.homework.clone())),
            ("mark", Json::num(self.mark)),
            ("isCancelled", Json::Bool(self.is_cancelled)),
        ])
    }
}

/// Таблица рейтинга класса целиком.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RankBoard {
    pub rows: Vec<RankRow>,
    pub summary: RankSummary,
    pub date: String,
    pub subject_id: Option<String>,
    pub subject_name: Option<String>,
}

impl RankBoard {
    pub fn to_json(&self) -> Json {
        Json::object(vec![
            ("rows", Json::Arr(self.rows.iter().map(RankRow::to_json).collect())),
            ("summary", self.summary.to_json()),
            ("date", Json::str(self.date.clone())),
            ("subjectId", Json::text_or_null(&self.subject_id)),
            ("subjectName", Json::text_or_null(&self.subject_name)),
        ])
    }
}
