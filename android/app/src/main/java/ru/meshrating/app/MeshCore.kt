package ru.meshrating.app

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Ядро работы с API МЭШ (school.mos.ru) для Android.
 *
 * Файл намеренно не зависит от классов Android: только org.json и java.*.
 * Благодаря этому его можно проверять обычными JVM-тестами (app/src/test)
 * без эмулятора, а поведение совпадает с desktop/web-версией
 * (shared/core/mesh-core.js) — обе реализации следуют одному контракту
 * (docs/API-CONTRACT.md).
 */
object MeshCore {

    const val HOST = "https://school.mos.ru"
    const val ROLE_ID = "1"
    const val SUBSYSTEM = "familyweb"
    const val SUBSYSTEM_ID = "2"
    const val PROFILE_TYPE = "student"

    const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/147.0.0.0 Mobile Safari/537.36"

    object Paths {
        const val PROFILE = "/api/family/web/v1/profile"
        const val PROFILE_BY_ID = "/api/gamification/v1/profiles"
        const val SUBJECTS = "/api/ej/rating/v1/rank/subjects"
        const val RANK = "/api/ej/rating/v1/rank/class"
        const val MARKS = "/api/family/web/v1/marks"
        const val SUBJECT_MARKS = "/api/family/web/v1/subject_marks"
        const val HOMEWORKS = "/api/family/web/v1/homeworks"
        const val SCHEDULE = "/api/family/web/v1/schedule"
        const val TOKEN_REFRESH = "/v2/token/refresh"
        const val USER_INFO = "/v3/userinfo"
    }

    /** Страница, после входа на которую МЭШ выдаёт свежий токен. */
    fun loginUrl(): String = "$HOST${Paths.TOKEN_REFRESH}?roleId=$ROLE_ID&subsystem=$SUBSYSTEM_ID"

    // ------------------------------------------------------------------ ошибки --

    class MeshError(
        message: String,
        val code: String = "error",
        val status: Int = 0,
        cause: Throwable? = null
    ) : Exception(message, cause)

    /** Человеческое описание ошибки для интерфейса (те же формулировки, что в desktop-версии). */
    fun describeError(error: Throwable): String = when {
        error !is MeshError -> error.message ?: error.toString()
        error.code == "network" -> "Нет связи с school.mos.ru. Проверьте интернет и попробуйте ещё раз."
        error.code == "timeout" -> "Сервер МЭШ не ответил вовремя. Попробуйте ещё раз."
        error.code == "unauthorized" -> "Токен недействителен или истёк. Выполните вход в МЭШ заново."
        error.code == "forbidden" -> "Нет доступа к данным (403). Возможно, нужен вход под ролью родителя."
        error.code == "not-found" -> "Метод недоступен для вашего региона (404)."
        error.code == "bad-token" -> "Значение не похоже на токен МЭШ."
        error.code == "invalid-json" -> "МЭШ вернул неожиданный ответ. Возможно, требуется повторный вход."
        error.code.startsWith("http-") -> "Ошибка сервера МЭШ (${error.status}). Попробуйте позже."
        else -> error.message ?: "Неизвестная ошибка"
    }

    // --------------------------------------------------------------- заголовки --

    fun baseHeaders(): Map<String, String> = mapOf(
        "Accept" to "application/json, text/plain, */*",
        "Accept-Language" to "ru-RU,ru;q=0.9",
        "Content-Type" to "application/json;charset=UTF-8",
        "Profile-Type" to PROFILE_TYPE,
        "User-Agent" to USER_AGENT,
        "X-Mes-RoleId" to ROLE_ID,
        "X-Mes-Subsystem" to SUBSYSTEM
    )

    /** МЭШ понимает оба заголовка: и Authorization, и Auth-Token. */
    fun authHeaders(token: String?, profileId: String?): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        if (!token.isNullOrBlank()) {
            headers["Authorization"] = "Bearer $token"
            headers["Auth-Token"] = token
        }
        if (!profileId.isNullOrBlank()) headers["Profile-Id"] = profileId
        return headers
    }

    // -------------------------------------------------------------------- токен --

    private val TOKEN_KEY_RE =
        Regex("^(token|access_token|accessToken|auth_token|authToken|auth-token|bearer|jwt)$", RegexOption.IGNORE_CASE)
    private val JWT_RE = Regex("eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}")
    private val JWT_FULL_RE = Regex("^eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}$")
    private val OPAQUE_RE = Regex("^[A-Za-z0-9._~+/=-]{24,}$")

    /** Похоже ли значение на токен МЭШ (JWT или длинная строка). */
    fun looksLikeToken(value: String?): Boolean {
        val text = value?.trim() ?: return false
        if (text.length < 20 || text.any { it.isWhitespace() }) return false
        if (JWT_RE.containsMatchIn(text)) return true
        return OPAQUE_RE.matches(text) && text.any { it.isLetter() } && text.any { it.isDigit() }
    }

    /**
     * Строка целиком — это токен (а не текст, внутри которого он встречается).
     * Нужно при разборе ответов входа: JSON/HTML с токеном внутри не должен
     * приниматься за сам токен.
     */
    fun isWholeToken(value: String?): Boolean {
        val text = value?.trim() ?: return false
        if (text.length < 20 || text.any { it.isWhitespace() }) return false
        if (JWT_FULL_RE.matches(text)) return true
        return OPAQUE_RE.matches(text) && text.any { it.isLetter() } && text.any { it.isDigit() }
    }

    /** Поиск токена в JSON-объекте по «говорящим» ключам. */
    fun extractTokenFromJson(node: Any?, depth: Int = 0): String? {
        if (node == null || depth > 6) return null
        when (node) {
            is String -> return if (looksLikeToken(node)) node.trim() else null
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    extractTokenFromJson(node.opt(i), depth + 1)?.let { return it }
                }
            }
            is JSONObject -> {
                for (key in node.keys()) {
                    if (TOKEN_KEY_RE.matches(key)) {
                        val value = node.optString(key)
                        if (looksLikeToken(value)) return value.trim()
                    }
                }
                for (key in node.keys()) {
                    extractTokenFromJson(node.opt(key), depth + 1)?.let { return it }
                }
            }
        }
        return null
    }

    /** Поиск токена в тексте: JSON, HTML или голая строка. */
    fun extractTokenFromText(text: String?): String? {
        val source = text?.trim() ?: return null
        if (source.isEmpty()) return null
        if (isWholeToken(source)) return source
        runCatching { extractTokenFromJson(JSONObject(source)) }.getOrNull()?.let { return it }
        runCatching { extractTokenFromJson(JSONArray(source)) }.getOrNull()?.let { return it }
        Regex("\"(?:token|access_token|accessToken|auth_token|authToken)\"\\s*[:=]\\s*\"([^\"]{16,})\"", RegexOption.IGNORE_CASE)
            .find(source)?.groupValues?.get(1)?.let { if (looksLikeToken(it)) return it }
        JWT_RE.find(source)?.value?.let { return it }
        return null
    }

    /** Поиск токена в URL (query или hash). */
    fun extractTokenFromUrl(url: String?): String? {
        val source = url ?: return null
        val patterns = listOf(
            Regex("[?#&]token=([^&#\\s]+)", RegexOption.IGNORE_CASE),
            Regex("[?#&]access_token=([^&#\\s]+)", RegexOption.IGNORE_CASE),
            Regex("[?#&]auth_token=([^&#\\s]+)", RegexOption.IGNORE_CASE)
        )
        for (pattern in patterns) {
            val match = pattern.find(source) ?: continue
            val decoded = runCatching { java.net.URLDecoder.decode(match.groupValues[1], "UTF-8") }.getOrNull()
                ?: match.groupValues[1]
            if (looksLikeToken(decoded)) return decoded
            extractTokenFromText(decoded)?.let { return it }
        }
        if (source.contains('#')) {
            val hash = source.substringAfter('#')
            if (looksLikeToken(hash)) return hash.trim()
        }
        return null
    }

    /** Универсальный поиск: URL → JSON/текст. */
    fun extractToken(source: String?): String? =
        extractTokenFromUrl(source) ?: extractTokenFromText(source)

    /** Разбор полезной нагрузки JWT без проверки подписи (для отображения). */
    fun decodeJwt(token: String?): JSONObject? {
        val parts = token?.split(".") ?: return null
        if (parts.size < 2) return null
        return runCatching {
            val payload = parts[1].replace('-', '+').replace('_', '/')
            val padded = payload + "=".repeat((4 - payload.length % 4) % 4)
            val bytes = android.util.Base64.decode(padded, android.util.Base64.DEFAULT)
            JSONObject(String(bytes, Charsets.UTF_8))
        }.getOrNull() ?: runCatching {
            val payload = parts[1].replace('-', '+').replace('_', '/')
            val padded = payload + "=".repeat((4 - payload.length % 4) % 4)
            JSONObject(String(java.util.Base64.getDecoder().decode(padded), Charsets.UTF_8))
        }.getOrNull()
    }

    /** "abcdef…yz12" — токен показываем только частично. */
    fun maskToken(token: String?): String {
        val text = token ?: return "—"
        if (text.length <= 12) return "•".repeat(text.length)
        return text.take(6) + "…" + text.takeLast(4)
    }

    /** Сведения о токене для экрана «Профиль». */
    fun describeToken(token: String?): JSONObject {
        val result = JSONObject()
        if (token.isNullOrBlank()) {
            result.put("present", false)
            result.put("kind", "none")
            result.put("mask", "—")
            return result
        }
        val jwt = decodeJwt(token)
        result.put("present", true)
        result.put("kind", if (jwt != null) "jwt" else "opaque")
        result.put("mask", maskToken(token))
        result.put("length", token.length)
        if (jwt != null) {
            if (jwt.has("exp")) result.put("expiresAt", jwt.optLong("exp") * 1000)
            if (jwt.has("iat")) result.put("issuedAt", jwt.optLong("iat") * 1000)
            if (jwt.has("sub")) result.put("subjects", jwt.optString("sub"))
        }
        val expiresAt = if (result.has("expiresAt")) result.optLong("expiresAt") else 0L
        result.put("expired", expiresAt > 0 && expiresAt < System.currentTimeMillis())
        return result
    }

    // ----------------------------------------------------------------- данные ----

    fun asString(value: Any?): String = when (value) {
        null, JSONObject.NULL -> ""
        is String -> value
        is Double -> if (value == Math.floor(value) && !value.isInfinite()) value.toLong().toString() else value.toString()
        else -> value.toString()
    }

    fun asNullableDouble(value: Any?): Double? = when (value) {
        null, JSONObject.NULL -> null
        is Number -> value.toDouble()
        is String -> value.replace(',', '.').trim().toDoubleOrNull()
        else -> null
    }

    fun asNullableInt(value: Any?): Int? = asNullableDouble(value)?.toInt()

    fun asBool(value: Any?): Boolean = when (value) {
        null, JSONObject.NULL -> false
        is Boolean -> value
        is Number -> value.toDouble() != 0.0
        is String -> value.trim().lowercase() in listOf("true", "1", "да", "yes")
        else -> false
    }

    fun firstDefined(vararg values: Any?): Any? {
        for (value in values) {
            if (value != null && value != JSONObject.NULL && !(value is String && value.isBlank())) return value
        }
        return null
    }

    fun round(value: Double?, digits: Int = 2): Double? {
        if (value == null) return null
        val factor = Math.pow(10.0, digits.toDouble())
        return Math.round(value * factor) / factor
    }

    fun mean(values: List<Double>): Double? = if (values.isEmpty()) null else values.sum() / values.size

    fun median(values: List<Double>): Double? {
        if (values.isEmpty()) return null
        val sorted = values.sorted()
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[middle] else (sorted[middle - 1] + sorted[middle]) / 2.0
    }

    /** Место значения в списке (1 — лучшее). */
    fun placeOf(values: List<Double>, value: Double?): Int? {
        if (value == null || values.isEmpty()) return null
        return values.count { it > value + 1e-9 } + 1
    }

    fun gradeColor(mark: Double?): String = when {
        mark == null -> "none"
        Math.round(mark).toInt() >= 5 -> "green"
        Math.round(mark).toInt() == 4 -> "yellow"
        Math.round(mark).toInt() == 3 -> "orange"
        else -> "red"
    }

    fun placeColor(place: Int?, total: Int?): String {
        if (place == null || total == null || total == 0) return "none"
        val share = place.toDouble() / total
        return when {
            share <= 0.15 -> "green"
            share <= 0.4 -> "yellow"
            share <= 0.7 -> "orange"
            else -> "red"
        }
    }

    fun trendDirection(current: Double?, previous: Double?, epsilon: Double = 0.005): Int {
        if (current == null || previous == null) return 0
        if (current - previous > epsilon) return 1
        if (previous - current > epsilon) return -1
        return 0
    }

    /** Гистограмма средних баллов класса (по умолчанию 2.0 … 5.0 шагом 0.5). */
    fun histogram(values: List<Double>, from: Double = 2.0, to: Double = 5.0, step: Double = 0.5): JSONArray {
        val buckets = JSONArray()
        if (step <= 0) return buckets
        // Последний интервал начинается в to - step: иначе появляется пустая корзина «to–to».
        var edge = to - step
        while (edge >= from - 1e-9) {
            val upper = minOf(edge + step, to)
            val isTop = upper >= to - 1e-9
            val count = values.count { it >= edge - 1e-9 && (if (isTop) it <= upper + 1e-9 else it < upper - 1e-9) }
            buckets.put(
                JSONObject()
                    .put("from", round(edge, 2))
                    .put("to", round(upper, 2))
                    .put("label", "${round(edge, 1)}–${round(upper, 1)}")
                    .put("count", count)
            )
            edge -= step
        }
        return buckets
    }

    fun personName(last: String?, first: String?, middle: String?): String =
        listOfNotNull(last, first, middle)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" ")

    fun payloadList(json: JSONObject?): JSONArray = when {
        json == null -> JSONArray()
        json.optJSONArray("payload") != null -> json.optJSONArray("payload")!!
        json.optJSONArray("items") != null -> json.optJSONArray("items")!!
        json.optJSONArray("data") != null -> json.optJSONArray("data")!!
        json.optJSONArray("lessons") != null -> json.optJSONArray("lessons")!!
        else -> JSONArray()
    }

    // ------------------------------------------------------------ нормализация --

    fun normalizeChild(child: JSONObject): JSONObject {
        val last = asString(firstDefined(child.opt("last_name"), child.opt("lastName")))
        val first = asString(firstDefined(child.opt("first_name"), child.opt("firstName")))
        val middle = asString(firstDefined(child.opt("middle_name"), child.opt("middleName")))
        val name = personName(last, first, middle).ifBlank { asString(firstDefined(child.opt("name"), "Ученик")) }
        return JSONObject()
            .put("id", asString(firstDefined(child.opt("id"), child.opt("user_id"), child.opt("student_id"))))
            .put("personId", asString(firstDefined(child.opt("contingent_guid"), child.opt("person_id"), child.opt("personId"))))
            .put("name", name)
            .put("shortName", first.ifBlank { name })
            .put("classId", asString(firstDefined(child.opt("class_id"), child.opt("classId"))))
            .put("className", asString(firstDefined(child.opt("class_name"), child.opt("className"))))
            .put("schoolId", asString(firstDefined(child.opt("school_id"), child.opt("schoolId"))))
            .put("schoolName", asString(firstDefined(child.opt("school_name"), child.opt("schoolName"))))
            .put("avatarUrl", asString(firstDefined(child.opt("avatar_url"), child.opt("avatarUrl"))))
    }

    /** Разбор ответа /api/family/web/v1/profile. */
    fun normalizeProfile(json: JSONObject): JSONObject {
        val profile = json.optJSONObject("profile") ?: JSONObject()
        val childrenArray = json.optJSONArray("children") ?: JSONArray()
        val children = JSONArray()
        for (i in 0 until childrenArray.length()) {
            childrenArray.optJSONObject(i)?.let { children.put(normalizeChild(it)) }
        }
        val parent = JSONObject()
            .put("id", asString(firstDefined(profile.opt("id"), profile.opt("user_id"))))
            .put(
                "name",
                personName(
                    asString(profile.opt("last_name")),
                    asString(profile.opt("first_name")),
                    asString(profile.opt("middle_name"))
                ).ifBlank { "Родитель" }
            )
            .put("email", asString(profile.opt("email")))
            .put("phone", asString(firstDefined(profile.opt("phone"), profile.opt("mobile_phone"))))
        return JSONObject()
            .put("parent", parent)
            .put("children", children)
            .put("defaultChild", if (children.length() > 0) children.optJSONObject(0) else JSONObject.NULL)
            .put("hash", asString(json.opt("hash")))
    }

    /** Предмет + рейтинг ученика по нему. */
    fun normalizeSubject(subject: JSONObject): JSONObject {
        val rank = subject.optJSONObject("rank") ?: JSONObject()
        return JSONObject()
            .put("id", asString(firstDefined(subject.opt("subjectId"), subject.opt("subject_id"), subject.opt("id"))))
            .put("name", asString(firstDefined(subject.opt("subjectName"), subject.opt("subject_name"), subject.opt("name"), "Предмет")))
            .put("average", asNullableDouble(firstDefined(rank.opt("averageMarkFive"), subject.opt("averageMarkFive"))) ?: JSONObject.NULL)
            .put("place", asNullableInt(firstDefined(rank.opt("rankPlace"), rank.opt("place"))) ?: JSONObject.NULL)
            .put("status", asString(rank.opt("rankStatus")))
            .put("trend", asString(rank.opt("trend")))
            .put("isExam", asBool(firstDefined(subject.opt("isExam"), subject.opt("is_exam"))))
    }

    /**
     * Таблица рейтинга класса: имена, место, «это я», дельты.
     * Соответствует shared/core/mesh-core.js → buildRankTable.
     */
    fun buildRankTable(members: JSONArray, names: Map<String, String>, meId: String?): JSONArray {
        val rows = mutableListOf<JSONObject>()
        for (i in 0 until members.length()) {
            val member = members.optJSONObject(i) ?: continue
            val rank = member.optJSONObject("rank") ?: JSONObject()
            val previous = member.optJSONObject("previousRank") ?: member.optJSONObject("previous_rank") ?: JSONObject()
            val personId = asString(firstDefined(member.opt("personId"), member.opt("person_id")))
            val average = asNullableDouble(firstDefined(rank.opt("averageMarkFive"), rank.opt("average_mark"), member.opt("averageMarkFive")))
            val previousAverage = asNullableDouble(firstDefined(previous.opt("averageMarkFive"), previous.opt("average_mark")))
            val place = asNullableInt(firstDefined(rank.opt("rankPlace"), rank.opt("place"))) ?: (i + 1)
            val previousPlace = asNullableInt(firstDefined(previous.opt("rankPlace"), previous.opt("place")))

            val placeDelta = if (previousPlace == null) null else previousPlace - place
            val averageDelta = if (average == null || previousAverage == null) null else round(average - previousAverage, 2)
            val trend = when {
                placeDelta != null -> if (placeDelta > 0) 1 else if (placeDelta < 0) -1 else 0
                else -> trendDirection(average, previousAverage)
            }
            rows.add(
                JSONObject()
                    .put("index", i)
                    .put("personId", personId)
                    .put("imageId", asString(firstDefined(member.opt("imageId"), member.opt("image_id"))))
                    .put("place", place)
                    .put("average", average ?: JSONObject.NULL)
                    .put("status", asString(rank.opt("rankStatus")))
                    .put("trend", asString(rank.opt("trend")))
                    .put("previousPlace", previousPlace ?: JSONObject.NULL)
                    .put("previousAverage", previousAverage ?: JSONObject.NULL)
                    .put("placeDelta", placeDelta ?: JSONObject.NULL)
                    .put("averageDelta", averageDelta ?: JSONObject.NULL)
                    .put("name", names[personId] ?: if (personId.isBlank()) "Неизвестный ученик" else "Ученик ${personId.take(8)}")
                    .put("isMe", !meId.isNullOrBlank() && personId == meId)
                    .put("color", gradeColor(average))
                    .put("trendDirection", trend)
                    .put("rankLabel", "#$place")
            )
        }
        val sorted = rows.sortedWith(compareBy({ it.optInt("place", Int.MAX_VALUE) }, { -(it.optDouble("average", 0.0)) }))
        return JSONArray(sorted)
    }

    /** Сводка по рейтингу класса — KPI-плитки на вкладке «Рейтинг». */
    fun summarizeRank(rows: JSONArray, meId: String?): JSONObject {
        val list = (0 until rows.length()).mapNotNull { rows.optJSONObject(it) }
        val averages = list.mapNotNull { asNullableDouble(it.opt("average")) }
        val me = list.firstOrNull { it.optBoolean("isMe") }
        val leader = list.firstOrNull()
        val summary = JSONObject()
        val classAverage = round(mean(averages), 2)

        summary.put("total", list.size)
        summary.put("withMarks", averages.size)
        summary.put("classAverage", classAverage ?: JSONObject.NULL)
        summary.put("classMedian", round(median(averages), 2) ?: JSONObject.NULL)
        summary.put("classMin", averages.minOrNull() ?: JSONObject.NULL)
        summary.put("classMax", averages.maxOrNull() ?: JSONObject.NULL)

        val myAverage = me?.let { asNullableDouble(it.opt("average")) }
        val myPlace = me?.let { asNullableInt(it.opt("place")) }
        summary.put("myAverage", myAverage ?: JSONObject.NULL)
        summary.put("myPlace", myPlace ?: JSONObject.NULL)
        summary.put("myRow", me ?: JSONObject.NULL)
        summary.put("myTrend", me?.optInt("trendDirection") ?: 0)
        summary.put("myDelta", me?.opt("averageDelta") ?: JSONObject.NULL)

        val leaderAverage = leader?.let { asNullableDouble(it.opt("average")) }
        summary.put(
            "leader",
            if (leader == null) JSONObject.NULL else JSONObject()
                .put("name", leader.optString("name"))
                .put("average", leaderAverage ?: JSONObject.NULL)
                .put("personId", leader.optString("personId"))
        )
        summary.put(
            "gapToLeader",
            if (myAverage == null || leaderAverage == null) JSONObject.NULL else round(leaderAverage - myAverage, 2) ?: JSONObject.NULL
        )

        // «сосед сверху» — ближайшее место выше моего
        val above = if (myPlace == null) emptyList() else list.filter { asNullableInt(it.opt("place")) ?: 0 < myPlace }
        val next = above.maxByOrNull { asNullableInt(it.opt("place")) ?: 0 }
        val nextAverage = next?.let { asNullableDouble(it.opt("average")) }
        summary.put(
            "gapToNext",
            if (myAverage == null || nextAverage == null) JSONObject.NULL else round(nextAverage - myAverage, 2) ?: JSONObject.NULL
        )
        summary.put("aheadOfMe", if (myPlace == null) JSONObject.NULL else list.count { (asNullableInt(it.opt("place")) ?: 0) < myPlace })
        summary.put("behindMe", if (myPlace == null) JSONObject.NULL else list.count { (asNullableInt(it.opt("place")) ?: 0) > myPlace })
        summary.put("aboveClassAverage", if (myAverage == null || classAverage == null) JSONObject.NULL else myAverage >= classAverage)

        val places = list.mapNotNull { asNullableInt(it.opt("place")) }
        summary.put("bestPlace", places.minOrNull() ?: JSONObject.NULL)
        summary.put("worstPlace", places.maxOrNull() ?: JSONObject.NULL)
        summary.put("histogram", histogram(averages))
        return summary
    }

    fun normalizeMark(mark: JSONObject): JSONObject = JSONObject()
        .put("id", asString(firstDefined(mark.opt("id"), mark.opt("mark_id"))))
        .put("value", asNullableDouble(firstDefined(mark.opt("value"), mark.opt("mark"))) ?: JSONObject.NULL)
        .put("subjectId", asString(firstDefined(mark.opt("subject_id"), mark.opt("subjectId"))))
        .put("subjectName", asString(firstDefined(mark.opt("subject_name"), mark.opt("subjectName"), "—")))
        .put("controlForm", asString(firstDefined(mark.opt("control_form_name"), mark.opt("controlForm"), "—")))
        .put("weight", asNullableDouble(mark.opt("weight")) ?: 1.0)
        .put("date", toIso(asString(firstDefined(mark.opt("created_at"), mark.opt("date"), today()))).take(10))
        .put("comment", asString(mark.opt("comment")))
        .put("isExam", asBool(firstDefined(mark.opt("is_exam"), mark.opt("isExam"))))

    fun normalizeHomework(item: JSONObject): JSONObject {
        val due = asString(firstDefined(item.opt("date_prepared"), item.opt("deadline"), item.opt("due_date")))
        return JSONObject()
            .put("id", asString(firstDefined(item.opt("homework_entry_student_id"), item.opt("homework_id"), item.opt("id"))))
            .put("subjectId", asString(firstDefined(item.opt("subject_id"), item.opt("subjectId"))))
            .put("subjectName", asString(firstDefined(item.opt("subject_name"), item.opt("subjectName"), "—")))
            .put("description", asString(firstDefined(item.opt("description"), item.opt("text"), item.opt("homework"))))
            .put("assignedOn", toIso(asString(firstDefined(item.opt("date_assigned_on"), item.opt("date"), today()))))
            .put("dueDate", if (due.isBlank()) JSONObject.NULL else toIso(due))
            .put("isDone", asBool(firstDefined(item.opt("is_done"), item.opt("isDone"))))
            .put("attachments", item.optJSONArray("attachments") ?: JSONArray())
    }

    /** Расписание: «терпимый» разбор — собираем уроки из известных структур. */
    fun normalizeSchedule(json: JSONObject?, defaultDate: String): JSONArray {
        val lessons = JSONArray()
        fun push(item: JSONObject?, dayIso: String?) {
            if (item == null) return
            val begin = asString(firstDefined(item.opt("begin_time"), item.opt("start_time"), item.opt("startTime"), item.opt("time_from")))
            val end = asString(firstDefined(item.opt("end_time"), item.opt("finish_time"), item.opt("endTime"), item.opt("time_to")))
            val subject = item.optJSONObject("subject")?.optString("name")
            val teacher = item.optJSONObject("teacher")?.optString("fio")
            val room = item.optJSONObject("room")?.optString("name")
            lessons.put(
                JSONObject()
                    .put("date", toIso(asString(firstDefined(item.opt("date"), item.opt("day"), dayIso, defaultDate))))
                    .put("number", asNullableInt(firstDefined(item.opt("lesson_number"), item.opt("number"))) ?: JSONObject.NULL)
                    .put("begin", if (begin.isBlank()) JSONObject.NULL else begin.take(5))
                    .put("end", if (end.isBlank()) JSONObject.NULL else end.take(5))
                    .put("subject", asString(firstDefined(item.opt("subject_name"), item.opt("subjectName"), subject, "—")))
                    .put("teacher", asString(firstDefined(item.opt("teacher_name"), item.opt("teacherName"), teacher)))
                    .put("room", asString(firstDefined(item.opt("room_name"), item.opt("room"), item.opt("cabinet"), room)))
                    .put("homework", asString(firstDefined(item.opt("homework"), item.opt("home_task"), item.opt("description"))))
                    .put("mark", asNullableDouble(firstDefined(item.opt("mark"), item.opt("mark_value"))) ?: JSONObject.NULL)
                    .put("isCancelled", asBool(firstDefined(item.opt("is_cancel"), item.opt("isCancelled"))))
            )
        }

        val list = payloadList(json)
        for (i in 0 until list.length()) {
            val entry = list.optJSONObject(i) ?: continue
            val dayIso = asString(firstDefined(entry.opt("date"), entry.opt("day"), entry.opt("date_from")))
            val nested = entry.optJSONArray("lessons") ?: entry.optJSONArray("lesson_list") ?: entry.optJSONArray("items")
            if (nested != null) {
                for (j in 0 until nested.length()) push(nested.optJSONObject(j), dayIso)
            } else {
                push(entry, dayIso.ifBlank { null })
            }
        }
        val sorted = (0 until lessons.length()).mapNotNull { lessons.optJSONObject(it) }
            .sortedWith(compareBy({ it.optString("date") }, { it.optString("begin") }, { it.optInt("number") }))
        return JSONArray(sorted)
    }

    /** Сводка по оценкам: средняя, взвешенная и по предметам. */
    fun summarizeMarks(marks: List<JSONObject>): JSONObject {
        val values = marks.mapNotNull { asNullableDouble(it.opt("value")) }
        var weightedSum = 0.0
        var weights = 0.0
        marks.forEach { mark ->
            val value = asNullableDouble(mark.opt("value")) ?: return@forEach
            val weight = (asNullableDouble(mark.opt("weight")) ?: 1.0).takeIf { it > 0 } ?: 1.0
            weightedSum += value * weight
            weights += weight
        }
        val bySubject = linkedMapOf<String, MutableList<JSONObject>>()
        marks.forEach { mark ->
            val key = mark.optString("subjectId").ifBlank { mark.optString("subjectName") }
            bySubject.getOrPut(key) { mutableListOf() }.add(mark)
        }
        val subjectList = bySubject.values.map { group ->
            val groupValues = group.mapNotNull { asNullableDouble(it.opt("value")) }
            val average = round(mean(groupValues), 2)
            JSONObject()
                .put("subjectId", group.first().optString("subjectId"))
                .put("subjectName", group.first().optString("subjectName"))
                .put("count", group.size)
                .put("average", average ?: JSONObject.NULL)
                .put("median", round(median(groupValues), 2) ?: JSONObject.NULL)
                .put("color", gradeColor(average))
                .put("marks", JSONArray(group.sortedByDescending { it.optString("date") }))
        }.sortedByDescending { it.optDouble("average", 0.0) }

        val byValue = JSONArray()
        listOf(5, 4, 3, 2, 1).forEach { value ->
            byValue.put(
                JSONObject()
                    .put("value", value)
                    .put("count", values.count { Math.round(it).toInt() == value })
                    .put("color", gradeColor(value.toDouble()))
            )
        }
        val sortedMarks = marks.sortedByDescending { it.optString("date") }
        return JSONObject()
            .put("count", marks.size)
            .put("withValue", values.size)
            .put("average", round(mean(values), 2) ?: JSONObject.NULL)
            .put("weightedAverage", if (weights > 0) round(weightedSum / weights, 2) ?: JSONObject.NULL else JSONObject.NULL)
            .put("median", round(median(values), 2) ?: JSONObject.NULL)
            .put("best", values.maxOrNull() ?: JSONObject.NULL)
            .put("worst", values.minOrNull() ?: JSONObject.NULL)
            .put("bySubject", JSONArray(subjectList))
            .put("byValue", byValue)
            .put("lastMark", sortedMarks.firstOrNull() ?: JSONObject.NULL)
    }

    // -------------------------------------------------------------------- даты ----

    private fun formatter(): SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    fun today(): String = formatter().format(Date())

    fun toIso(value: String?): String {
        val text = value?.trim() ?: return today()
        val iso = Regex("^(\\d{4})-(\\d{2})-(\\d{2})").find(text)
        if (iso != null) return "${iso.groupValues[1]}-${iso.groupValues[2]}-${iso.groupValues[3]}"
        val ru = Regex("^(\\d{2})\\.(\\d{2})\\.(\\d{4})").find(text)
        if (ru != null) return "${ru.groupValues[3]}-${ru.groupValues[2]}-${ru.groupValues[1]}"
        return today()
    }

    fun parseIso(iso: String): Calendar {
        val calendar = Calendar.getInstance()
        runCatching { calendar.time = formatter().parse(toIso(iso))!! }
        return calendar
    }

    fun addDays(iso: String, days: Int): String {
        val calendar = parseIso(iso)
        calendar.add(Calendar.DAY_OF_YEAR, days)
        return formatter().format(calendar.time)
    }

    /** Первый день учебного года (1 сентября). */
    fun schoolYearStart(iso: String): String {
        val calendar = parseIso(iso)
        val year = if (calendar.get(Calendar.MONTH) >= Calendar.AUGUST) {
            calendar.get(Calendar.YEAR)
        } else {
            calendar.get(Calendar.YEAR) - 1
        }
        return "$year-09-01"
    }

    private val MONTHS = listOf(
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря"
    )
    private val WEEKDAYS = listOf("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")

    /** "2026-10-12" → "12 октября 2026". */
    fun dateRu(iso: String, weekday: Boolean = false): String {
        val calendar = parseIso(iso)
        val text = "${calendar.get(Calendar.DAY_OF_MONTH)} ${MONTHS[calendar.get(Calendar.MONTH)]} ${calendar.get(Calendar.YEAR)}"
        if (!weekday) return text
        val index = (calendar.get(Calendar.DAY_OF_WEEK) + 5) % 7 // понедельник = 0
        return "${WEEKDAYS[index]}, $text"
    }

    /** "2026-10-12" → "12.10.2026". */
    fun dateShort(iso: String?): String {
        if (iso.isNullOrBlank()) return "—"
        val normalized = toIso(iso)
        return "${normalized.substring(8, 10)}.${normalized.substring(5, 7)}.${normalized.substring(0, 4)}"
    }

    fun dateRangeText(from: String, to: String): String = "${dateShort(from)} — ${dateShort(to)}"
}
