package ru.meshrating.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.Random
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Демо-сервер МЭШ для Android: поднимается на 127.0.0.1 и отдаёт те же методы,
 * что и настоящий school.mos.ru (тот же формат ответов, что у мок-сервера
 * в tools/mock-mesh-server.js).
 *
 * Нужен, чтобы посмотреть интерфейс без аккаунта МЭШ: «Демо-режим» в меню.
 * Данные генерируются детерминированно (seed), поэтому таблицы всегда одинаковые.
 *
 * Файл не зависит от Android — используется и в JVM-тестах (MeshClientTest).
 */
class DemoMeshServer(
    private val seed: Long = 20_261_012L,
    private val classSize: Int = 26,
    var tokenLifetime: Int = 3
) {

    companion object {
        const val UUID_ME = "11111111-1111-4111-8111-111111111111"
        const val UUID_SIBLING = "22222222-2222-4222-8222-222222222222"
        const val DEMO_TOKEN = "mock-token-1"

        val SUBJECTS = listOf(
            1 to "Алгебра", 2 to "Геометрия", 3 to "Русский язык", 4 to "Литература",
            5 to "Английский язык", 6 to "История", 7 to "Обществознание", 8 to "География",
            9 to "Биология", 10 to "Физика", 11 to "Химия", 12 to "Информатика",
            13 to "ОБЖ", 14 to "Физическая культура"
        )

        private val SURNAMES = listOf(
            "Абрамов", "Белова", "Виноградов", "Гусева", "Дмитриев", "Ершова", "Жукова", "Зайцев",
            "Иванова", "Кузнецов", "Лебедева", "Морозов", "Никитина", "Орлов", "Петрова", "Романов",
            "Смирнова", "Тимофеев", "Ульянова", "Фролова", "Харитонов", "Цветкова", "Чернов", "Шилова",
            "Щербаков", "Юдина", "Яковлев"
        )
        private val FIRST_M = listOf("Артём", "Максим", "Иван", "Дмитрий", "Егор", "Кирилл", "Никита", "Александр", "Пётр", "Лев")
        private val FIRST_F = listOf("Анна", "Мария", "София", "Ева", "Полина", "Дарья", "Виктория", "Ксения", "Алиса", "Вера")
        private val MIDDLE_M = listOf("Алексеевич", "Сергеевич", "Дмитриевич", "Иванович", "Павлович")
        private val MIDDLE_F = listOf("Алексеевна", "Сергеевна", "Дмитриевна", "Ивановна", "Павловна")
        private val TEACHERS = listOf("Соколова И. П.", "Гаврилов А. Н.", "Мельникова О. В.", "Ткачук Д. С.", "Васильева Е. А.")
        private val ROOMS = listOf("204", "211", "306", "каб. 118", "спортзал", "актовый зал")
        private val FORMS = listOf(
            "Контрольная работа", "Самостоятельная работа", "Ответ на уроке",
            "Домашняя работа", "Диктант", "Тест", "Проект", "Зачёт"
        )
    }

    private data class Student(
        val personId: String,
        val lastName: String,
        val firstName: String,
        val middleName: String
    ) {
        /** Средние оценки по предметам (база «силы» ученика). */
        val profile = mutableMapOf<Int, Double>()
    }

    /** marks[personId][subjectId] = список оценок */
    private val marks = mutableMapOf<String, MutableMap<Int, MutableList<Mark>>>()
    private data class Mark(val value: Int, val date: String, val weight: Int, val form: String)

    private val students = mutableListOf<Student>()
    private val issuedTokens = mutableSetOf(DEMO_TOKEN)
    private val tokenUses = mutableMapOf(DEMO_TOKEN to 0)
    private var tokenCounter = 1
    private var serverSocket: ServerSocket? = null
    private var executor: ExecutorService? = null
    private lateinit var me: Student

    var port: Int = 0
        private set

    init {
        generate()
    }

    /** Индекс «моего» ученика в списке класса. */
    private fun myIndex(): Int = 12.coerceAtMost(classSize - 1).coerceAtLeast(0)

    /** Числовой id ребёнка из профиля → personId (contingent_guid) в демо-данных. */
    private fun personIdForStudentId(studentId: String?): String =
        if (studentId == "17234614" && students.isNotEmpty()) students.first().personId else me.personId

    private fun generate() {
        val random = Random(seed)
        for (index in 0 until classSize) {
            val female = random.nextBoolean()
            val lastName = SURNAMES[index % SURNAMES.size] + if (female) "а" else ""
            val firstName = (if (female) FIRST_F else FIRST_M)[random.nextInt(if (female) FIRST_F.size else FIRST_M.size)]
            val middleName = (if (female) MIDDLE_F else MIDDLE_M)[random.nextInt(MIDDLE_F.size)]
            val student = Student(
                personId = "p-%03d-%s".format(index + 1, (index * 7919 % 1000).toString(36)),
                lastName = lastName,
                firstName = firstName,
                middleName = middleName
            )
            val base = 3.15 + random.nextDouble() * 1.6
            SUBJECTS.forEach { (id, name) ->
                val tilt = when {
                    name in listOf("Алгебра", "Геометрия", "Физика", "Информатика") -> 0.25
                    name in listOf("Физическая культура", "ОБЖ") -> 0.05
                    else -> -0.1
                }
                student.profile[id] = (base + tilt + (random.nextDouble() - 0.5) * 1.1).coerceIn(2.3, 5.0)
            }
            students.add(student)
        }
        me = students[myIndex()]

        val today = MeshCore.today()
        var cursor = MeshCore.schoolYearStart(today)
        val history = mutableListOf<String>()
        while (cursor < today && history.size < 120) {
            history.add(cursor)
            cursor = MeshCore.addDays(cursor, 9)
        }

        students.forEach { student ->
            val bySubject = mutableMapOf<Int, MutableList<Mark>>()
            SUBJECTS.forEach { (id, _) ->
                val ability = student.profile[id] ?: 4.0
                val list = mutableListOf<Mark>()
                history.forEachIndexed { index, date ->
                    if (random.nextDouble() < 0.55) {
                        var value = Math.round(ability + (random.nextDouble() - 0.42) * 1.15 + Math.sin(index / 2.0) * 0.18).toInt()
                        value = value.coerceIn(2, 5)
                        list.add(Mark(value, date, listOf(1, 1, 1, 2, 3)[random.nextInt(5)], FORMS[random.nextInt(FORMS.size)]))
                    }
                }
                bySubject[id] = list
            }
            marks[student.personId] = bySubject
        }
    }

    private fun averageOf(values: List<Int>): Double? =
        if (values.isEmpty()) null else MeshCore.round(values.average(), 2)

    /** Средние по предметам: subjectId = null → по всем предметам вместе. */
    private fun averages(personId: String, subjectId: Int?, toDate: String? = null): Map<Int, Double?> {
        val perSubject = marks[personId] ?: return emptyMap()
        val result = mutableMapOf<Int, Double?>()
        SUBJECTS.forEach { (id, _) ->
            if (subjectId != null && subjectId != id) return@forEach
            val values = (perSubject[id] ?: emptyList()).filter { toDate == null || it.date <= toDate }.map { it.value }
            result[id] = averageOf(values)
        }
        return result
    }

    private fun overallAverage(personId: String, toDate: String? = null): Double? {
        val values = averages(personId, null, toDate).values.filterNotNull()
        return if (values.isEmpty()) null else MeshCore.round(values.average(), 2)
    }

    // ------------------------------------------------------------------ жизнь ---

    /** Запускает сервер на свободном порту 127.0.0.1. */
    fun start(): Int {
        val socket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        serverSocket = socket
        port = socket.localPort
        executor = Executors.newFixedThreadPool(4)
        executor?.submit {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (error: Exception) {
                    break
                }
                executor?.submit { handle(client) }
            }
        }
        return port
    }

    fun stop() {
        runCatching { serverSocket?.close() }
        runCatching { executor?.shutdownNow() }
    }

    fun baseUrl(): String = "http://127.0.0.1:$port"

    private fun handle(client: Socket) {
        client.use { socket ->
            try {
                val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val path = parts[1]
                var authorization = ""
                var authToken = ""
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    val lower = line.lowercase()
                    when {
                        lower.startsWith("authorization:") -> authorization = line.substringAfter(':').trim()
                        lower.startsWith("auth-token:") -> authToken = line.substringAfter(':').trim()
                    }
                }
                val token = authorization.removePrefix("Bearer").trim().ifBlank { authToken }
                val (status, payload) = route(path, token)
                respond(socket, status, payload)
            } catch (error: Exception) {
                runCatching { respond(socket, 500, JSONObject().put("message", "demo error: ${error.message}")) }
            }
        }
    }

    private fun query(path: String): Pair<String, Map<String, String>> {
        val index = path.indexOf('?')
        if (index < 0) return path to emptyMap()
        val params = path.substring(index + 1).split('&').mapNotNull { pair ->
            val parts = pair.split('=', limit = 2)
            if (parts.size == 2) {
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
            } else {
                null
            }
        }.toMap()
        return path.substring(0, index) to params
    }

    private fun respond(socket: Socket, status: Int, payload: JSONObject) {
        val body = payload.toString().toByteArray(Charsets.UTF_8)
        val header = buildString {
            append("HTTP/1.1 $status ${if (status == 200) "OK" else "Error"}\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ${body.size}\r\n")
            append("Connection: close\r\n\r\n")
        }
        val out: OutputStream = socket.getOutputStream()
        out.write(header.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    private fun route(fullPath: String, token: String): Pair<Int, JSONObject> {
        val (path, params) = query(fullPath)

        // обновление токена: нужен действующий токен
        if (path == MeshCore.Paths.TOKEN_REFRESH) {
            if (!issuedTokens.contains(token)) {
                return 401 to JSONObject().put("message", "Unauthorized")
            }
            val next = "mock-token-${++tokenCounter}"
            issuedTokens.add(next)
            tokenUses[next] = 0
            return 200 to JSONObject()
                .put("token", next)
                .put("role_id", MeshCore.ROLE_ID)
                .put("subsystem", MeshCore.SUBSYSTEM)
                .put("expires_at", System.currentTimeMillis() + 3_600_000)
        }

        if (!issuedTokens.contains(token)) return 401 to JSONObject().put("message", "Unauthorized")
        tokenUses[token] = (tokenUses[token] ?: 0) + 1
        if ((tokenUses[token] ?: 0) > tokenLifetime) {
            // «протухший» токен: клиент обязан обновить его сам
            return 401 to JSONObject().put("message", "Token expired")
        }

        val today = MeshCore.today()

        return when (path) {
            MeshCore.Paths.PROFILE -> 200 to JSONObject()
                .put("hash", "demo-hash")
                .put(
                    "profile",
                    JSONObject()
                        .put("id", 900_001)
                        .put("last_name", "Демидова")
                        .put("first_name", "Ольга")
                        .put("middle_name", "Сергеевна")
                        .put("email", "parent@example.ru")
                        .put("phone", "+7 (999) 000-00-00")
                )
                .put(
                    "children",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put("id", 17_234_613)
                                .put("contingent_guid", UUID_ME)
                                .put("last_name", me.lastName)
                                .put("first_name", me.firstName)
                                .put("middle_name", me.middleName)
                                .put("class_name", "7 «Б»")
                                .put("school_name", "ГБОУ Школа № 1234")
                        )
                        .put(
                            JSONObject()
                                .put("id", 17_234_614)
                                .put("contingent_guid", UUID_SIBLING)
                                .put("last_name", students.first().lastName)
                                .put("first_name", students.first().firstName)
                                .put("middle_name", students.first().middleName)
                                .put("class_name", "3 «А»")
                                .put("school_name", "ГБОУ Школа № 1234")
                        )
                )

            MeshCore.Paths.PROFILE_BY_ID -> {
                val personId = params["personId"]
                val student = students.firstOrNull { it.personId == personId }
                if (student == null) {
                    404 to JSONObject().put("message", "person not found")
                } else {
                    200 to JSONObject()
                        .put("firstName", student.firstName)
                        .put("lastName", student.lastName)
                        .put("middleName", student.middleName)
                }
            }

            MeshCore.Paths.SUBJECTS -> {
                val personId = params["personId"] ?: UUID_ME
                val date = params["date"] ?: today
                val mine = averages(personId, null, date)
                val payload = JSONArray()
                SUBJECTS.forEach { (id, name) ->
                    val all = students.mapNotNull { averages(it.personId, id, date)[id] }
                    val value = mine[id]
                    payload.put(
                        JSONObject()
                            .put("subjectId", id)
                            .put("subjectName", name)
                            .put(
                                "rank",
                                JSONObject()
                                    .put("averageMarkFive", value ?: JSONObject.NULL)
                                    .put("rankPlace", MeshCore.placeOf(all, value) ?: JSONObject.NULL)
                                    .put("rankStatus", if (value == null) "NO_DATA" else if ((MeshCore.placeOf(all, value) ?: 99) <= all.size * 0.3) "TOP" else "MIDDLE")
                                    .put("trend", if (random.nextBoolean()) "+0.25" else "-0.10")
                            )
                            .put("isExam", id == 1 || id == 3)
                    )
                }
                200 to JSONObject().put("payload", payload)
            }

            MeshCore.Paths.RANK -> {
                val subjectId = params["subjectId"]?.toIntOrNull()
                val date = params["date"] ?: today
                val previousDate = MeshCore.addDays(date, -30)
                val rows = students.map { student ->
                    val value = if (subjectId != null) averages(student.personId, subjectId, date)[subjectId] else overallAverage(student.personId, date)
                    val before = if (subjectId != null) averages(student.personId, subjectId, previousDate)[subjectId] else overallAverage(student.personId, previousDate)
                    Triple(student.personId, value, before)
                }
                val currentValues = rows.mapNotNull { it.second }
                val previousValues = rows.mapNotNull { it.third }
                val payload = JSONArray()
                rows.forEach { (personId, value, before) ->
                    payload.put(
                        JSONObject()
                            .put("personId", personId)
                            .put("imageId", 0)
                            .put(
                                "rank",
                                JSONObject()
                                    .put("averageMarkFive", value ?: JSONObject.NULL)
                                    .put("rankPlace", MeshCore.placeOf(currentValues, value) ?: JSONObject.NULL)
                                    .put("rankStatus", if ((MeshCore.placeOf(currentValues, value) ?: 99) <= 5) "TOP" else "MIDDLE")
                                    .put("trend", "%.2f".format((value ?: 0.0) - (before ?: 0.0)))
                            )
                            .put(
                                "previousRank",
                                JSONObject()
                                    .put("averageMarkFive", before ?: JSONObject.NULL)
                                    .put("rankPlace", MeshCore.placeOf(previousValues, before) ?: JSONObject.NULL)
                            )
                    )
                }
                200 to JSONObject().put("payload", payload)
            }

            MeshCore.Paths.MARKS -> {
                val studentId = params["student_id"] ?: UUID_ME
                val from = params["from"] ?: "2000-01-01"
                val to = params["to"] ?: today
                val personId = personIdForStudentId(studentId)
                val payload = JSONArray()
                SUBJECTS.forEach { (id, name) ->
                    (marks[personId]?.get(id) ?: emptyList()).forEachIndexed { index, mark ->
                        if (mark.date < from || mark.date > to) return@forEachIndexed
                        payload.put(
                            JSONObject()
                                .put("id", "$id$index${personId.takeLast(3)}")
                                .put("value", mark.value)
                                .put("subject_id", id)
                                .put("subject_name", name)
                                .put("control_form_name", mark.form)
                                .put("weight", mark.weight)
                                .put("created_at", mark.date)
                                .put("is_exam", id % 7 == 0)
                                .put("comment", if (index % 7 == 3) "Были недочёты в оформлении" else "")
                        )
                    }
                }
                200 to JSONObject().put("payload", payload)
            }

            MeshCore.Paths.SUBJECT_MARKS -> {
                val studentId = params["student_id"] ?: UUID_ME
                val personId = personIdForStudentId(studentId)
                val payload = JSONArray()
                SUBJECTS.forEach { (id, name) ->
                    val values = (marks[personId]?.get(id) ?: emptyList()).map { it.value }
                    payload.put(
                        JSONObject()
                            .put("subject_id", id)
                            .put("subject_name", name)
                            .put("marks", JSONArray(values))
                            .put("average", averageOf(values) ?: JSONObject.NULL)
                            .put("final_mark", if (values.isEmpty()) JSONObject.NULL else Math.round(values.average()).toInt())
                    )
                }
                200 to JSONObject().put("payload", payload)
            }

            MeshCore.Paths.HOMEWORKS -> {
                val from = params["from"] ?: MeshCore.addDays(today, -7)
                val to = params["to"] ?: MeshCore.addDays(today, 7)
                val random = Random(4242)
                val payload = JSONArray()
                var cursor = from
                while (cursor <= to) {
                    val calendar = MeshCore.parseIso(cursor)
                    val weekday = calendar.get(java.util.Calendar.DAY_OF_WEEK)
                    if (weekday != java.util.Calendar.SATURDAY && weekday != java.util.Calendar.SUNDAY) {
                        val count = 3 + random.nextInt(3)
                        repeat(count) { index ->
                            val (subjectId, subjectName) = SUBJECTS[random.nextInt(SUBJECTS.size)]
                            val page = 10 + random.nextInt(150)
                            payload.put(
                                JSONObject()
                                    .put("homework_entry_student_id", "$cursor-$subjectId-$index")
                                    .put("subject_id", subjectId)
                                    .put("subject_name", subjectName)
                                    .put("date_assigned_on", cursor)
                                    .put("date_prepared", MeshCore.addDays(cursor, 1 + random.nextInt(3)))
                                    .put("description", "Параграф $page, вопросы 1–4 письменно")
                                    .put("is_done", random.nextDouble() > 0.55)
                                    .put("attachments", if (random.nextDouble() > 0.9) JSONArray().put(JSONObject().put("name", "task.pdf")) else JSONArray())
                            )
                        }
                    }
                    cursor = MeshCore.addDays(cursor, 1)
                }
                200 to JSONObject().put("payload", payload)
            }

            MeshCore.Paths.SCHEDULE -> {
                val date = params["date"] ?: today
                val random = Random(date.replace("-", "").toLong())
                val pool = SUBJECTS.shuffled(random).take(7)
                val begins = listOf("08:30", "09:25", "10:30", "11:25", "12:30", "13:25", "14:30")
                val ends = listOf("09:15", "10:10", "11:15", "12:10", "13:15", "14:10", "15:15")
                val payload = JSONArray()
                pool.forEachIndexed { index, (subjectId, subjectName) ->
                    payload.put(
                        JSONObject()
                            .put("date", date)
                            .put("lesson_number", index + 1)
                            .put("begin_time", begins[index])
                            .put("end_time", ends[index])
                            .put("subject_name", subjectName)
                            .put("teacher_name", TEACHERS[random.nextInt(TEACHERS.size)])
                            .put("room_name", ROOMS[random.nextInt(ROOMS.size)])
                            .put("homework", if (random.nextBoolean()) "см. домашнее задание в журнале" else "")
                            .put("mark", if (random.nextDouble() > 0.8) 5 else JSONObject.NULL)
                            .put("is_cancel", random.nextDouble() > 0.96)
                    )
                }
                200 to JSONObject().put("payload", payload)
            }

            else -> 404 to JSONObject().put("message", "demo: unknown path $path")
        }
    }
}
