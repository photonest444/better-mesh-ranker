package ru.meshrating.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.net.UnknownHostException
import java.io.InputStreamReader

/**
 * HTTP-клиент МЭШ: таймауты, понятные ошибки и автоматическое обновление токена.
 *
 * При ответе 401 клиент один раз запрашивает свежий токен методом
 * GET /v2/token/refresh?roleId=1&subsystem=2 (с текущим Bearer), сохраняет его
 * через [onToken] и повторяет исходный запрос. Пользователю не нужно входить снова.
 *
 * Файл не зависит от Android-классов — покрыт обычными JVM-тестами.
 */
class MeshClient(
    var baseUrl: String = MeshCore.HOST,
    var token: String? = null,
    var profileId: String? = null,
    private val timeoutMs: Int = 20_000,
    var autoRefresh: Boolean = true,
    private val onToken: ((String) -> Unit)? = null,
    val nameCache: MutableMap<String, String> = mutableMapOf()
) {

    /** Счётчик запросов — используется в диагностике. */
    var requestCount: Int = 0
        private set

    private fun buildUrl(path: String, params: Map<String, Any?> = emptyMap()): String {
        val query = params.entries
            .filter { it.value != null && it.value.toString().isNotEmpty() }
            .joinToString("&") { (key, value) ->
                "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value.toString(), "UTF-8")}"
            }
        return baseUrl.trimEnd('/') + path + if (query.isEmpty()) "" else "?$query"
    }

    private fun headers(extra: Map<String, String> = emptyMap()): Map<String, String> =
        MeshCore.baseHeaders() + MeshCore.authHeaders(token, profileId) + extra

    /** Базовый GET с обработкой кода ответа и ошибок сети. */
    fun request(path: String, params: Map<String, Any?> = emptyMap(), retryOn401: Boolean = true): JSONObject? {
        val url = buildUrl(path, params)
        var attempt = 0
        val maxAttempts = if (autoRefresh && retryOn401) 2 else 1

        while (attempt < maxAttempts) {
            attempt++
            val connection = try {
                (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    instanceFollowRedirects = true
                    headers().forEach { (key, value) -> setRequestProperty(key, value) }
                }
            } catch (error: Exception) {
                throw MeshCore.MeshError("Не удалось создать запрос: ${error.message}", "network", 0, error)
            }

            requestCount++
            val status: Int
            val body: String
            try {
                status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                body = stream?.let { BufferedReader(InputStreamReader(it, Charsets.UTF_8)).readText() } ?: ""
            } catch (error: SocketTimeoutException) {
                connection.disconnect()
                throw MeshCore.MeshError("Таймаут запроса к МЭШ", "timeout", 0, error)
            } catch (error: UnknownHostException) {
                connection.disconnect()
                throw MeshCore.MeshError("Нет связи с school.mos.ru", "network", 0, error)
            } catch (error: Exception) {
                connection.disconnect()
                throw MeshCore.MeshError("Ошибка сети: ${error.message}", "network", 0, error)
            } finally {
                connection.disconnect()
            }

            when {
                status == 401 && attempt < maxAttempts -> {
                    val refreshed = refreshToken()
                    if (refreshed != null) continue
                    throw MeshCore.MeshError("Токен истёк, обновить не удалось", "unauthorized", 401)
                }
                status == 401 -> throw MeshCore.MeshError("Не авторизован (401)", "unauthorized", 401)
                status == 403 -> throw MeshCore.MeshError("Доступ запрещён (403)", "forbidden", 403)
                status == 404 -> throw MeshCore.MeshError("Метод не найден (404): $path", "not-found", 404)
                status !in 200..299 -> throw MeshCore.MeshError("Ошибка МЭШ: HTTP $status", "http-$status", status)
            }

            if (body.isBlank()) return null
            return try {
                JSONObject(body)
            } catch (error: Exception) {
                // некоторые методы отдают массив на верхнем уровне
                try {
                    JSONObject().put("payload", JSONArray(body))
                } catch (inner: Exception) {
                    MeshCore.extractTokenFromText(body)?.let { return JSONObject().put("token", it) }
                    throw MeshCore.MeshError("Не удалось разобрать ответ МЭШ", "invalid-json", status, error)
                }
            }
        }
        throw MeshCore.MeshError("Запрос не выполнен: $path", "exhausted")
    }

    /**
     * Обновление токена. Возвращает новый токен или null, если МЭШ его не выдал.
     * Запрос идёт с текущим токеном — ровно так же, как это делает веб-страница
     * /v2/token/refresh?roleId=1&subsystem=2.
     */
    @Synchronized
    fun refreshToken(): String? {
        val current = token ?: return null
        val url = buildUrl(MeshCore.Paths.TOKEN_REFRESH, mapOf("roleId" to MeshCore.ROLE_ID, "subsystem" to MeshCore.SUBSYSTEM_ID))
        return try {
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                (MeshCore.baseHeaders() + MeshCore.authHeaders(current, null)).forEach { (key, value) ->
                    setRequestProperty(key, value)
                }
            }
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.let { BufferedReader(InputStreamReader(it, Charsets.UTF_8)).readText() } ?: ""
            connection.disconnect()

            val fresh = MeshCore.extractTokenFromText(body)
                ?: MeshCore.extractTokenFromUrl(url)
                ?: looseToken(body)
            if (status in 200..299 && !fresh.isNullOrBlank() && fresh != current) {
                token = fresh
                onToken?.invoke(fresh)
                fresh
            } else {
                null
            }
        } catch (error: Exception) {
            null
        }
    }

    // --------------------------------------------------------------- методы МЭШ --

    /**
     * «Мягкое» извлечение токена для демо-режима: локальный сервер отдаёт
     * короткие токены вида mock-token-2, не проходящие строгую проверку.
     */
    private fun looseToken(body: String): String? {
        val loose = Regex("^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?", RegexOption.IGNORE_CASE)
            .containsMatchIn(baseUrl)
        if (!loose || body.isBlank()) return null
        return runCatching { JSONObject(body).optString("token").takeIf { it.isNotBlank() } }.getOrNull()
    }

    fun fetchProfile(): JSONObject {
        val json = request(MeshCore.Paths.PROFILE, retryOn401 = false)
            ?: throw MeshCore.MeshError("Пустой ответ профиля", "invalid-json")
        return MeshCore.normalizeProfile(json)
    }

    /**
     * Вход по токену: проверяем токен профилем и запоминаем ученика.
     * @return JSONObject { token, profile, child, profileId }
     */
    fun signIn(rawToken: String?): JSONObject {
        val candidate = MeshCore.extractToken(rawToken) ?: rawToken?.trim() ?: ""
        if (candidate.isEmpty()) throw MeshCore.MeshError("Пустой токен", "bad-token")
        // Демо-режим работает с локальным сервером, где токены короткие
        val loose = Regex("^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?", RegexOption.IGNORE_CASE)
            .containsMatchIn(baseUrl)
        if (!MeshCore.looksLikeToken(candidate) && !loose) {
            throw MeshCore.MeshError("Значение не похоже на токен МЭШ", "bad-token")
        }
        token = candidate
        val profile = fetchProfile()
        val child = profile.optJSONObject("defaultChild")
        profileId = child?.optString("id")?.takeIf { it.isNotBlank() }
        return JSONObject()
            .put("token", candidate)
            .put("profile", profile)
            .put("child", child ?: JSONObject.NULL)
            .put("profileId", profileId ?: JSONObject.NULL)
    }

    fun getSubjects(personId: String?, date: String = MeshCore.today()): JSONArray {
        val json = request(MeshCore.Paths.SUBJECTS, mapOf("date" to date, "personId" to personId))
        val list = MeshCore.payloadList(json)
        val result = JSONArray()
        for (i in 0 until list.length()) {
            list.optJSONObject(i)?.let { result.put(MeshCore.normalizeSubject(it)) }
        }
        return result
    }

    fun getRank(personId: String?, date: String = MeshCore.today(), subjectId: String? = null): JSONArray {
        val json = request(MeshCore.Paths.RANK, mapOf("personId" to personId, "date" to date, "subjectId" to subjectId))
        return MeshCore.payloadList(json)
    }

    fun getMarks(studentId: String?, from: String, to: String): List<JSONObject> {
        val json = request(MeshCore.Paths.MARKS, mapOf("student_id" to studentId, "from" to from, "to" to to))
        val list = MeshCore.payloadList(json)
        return (0 until list.length()).mapNotNull { list.optJSONObject(it)?.let { mark -> MeshCore.normalizeMark(mark) } }
    }

    fun getSubjectMarks(studentId: String?): JSONArray =
        MeshCore.payloadList(request(MeshCore.Paths.SUBJECT_MARKS, mapOf("student_id" to studentId)))

    fun getHomeworks(studentId: String?, from: String, to: String): List<JSONObject> {
        val json = request(MeshCore.Paths.HOMEWORKS, mapOf("student_id" to studentId, "from" to from, "to" to to))
        val list = MeshCore.payloadList(json)
        return (0 until list.length()).mapNotNull { list.optJSONObject(it)?.let { item -> MeshCore.normalizeHomework(item) } }
    }

    fun getSchedule(studentId: String?, date: String = MeshCore.today()): JSONArray =
        MeshCore.normalizeSchedule(request(MeshCore.Paths.SCHEDULE, mapOf("student_id" to studentId, "date" to date)), date)

    /** Имя ученика по personId (с кэшем — на класс обычно один запрос на человека). */
    fun getName(personId: String?): String {
        val key = personId?.trim().orEmpty()
        if (key.isEmpty()) return "Неизвестный ученик"
        nameCache[key]?.let { return it }
        val name = try {
            val json = request(MeshCore.Paths.PROFILE_BY_ID, mapOf("personId" to key))
                ?: throw MeshCore.MeshError("Пустой профиль", "invalid-json")
            MeshCore.personName(
                MeshCore.asString(MeshCore.firstDefined(json.opt("lastName"), json.opt("last_name"))),
                MeshCore.asString(MeshCore.firstDefined(json.opt("firstName"), json.opt("first_name"))),
                MeshCore.asString(MeshCore.firstDefined(json.opt("middleName"), json.opt("middle_name")))
            ).ifBlank { "Ученик ${key.take(8)}" }
        } catch (error: Exception) {
            "Ученик ${key.take(8)}"
        }
        nameCache[key] = name
        return name
    }

    fun getNames(personIds: List<String>): Map<String, String> {
        val result = linkedMapOf<String, String>()
        personIds.map { it.trim() }.filter { it.isNotEmpty() }.distinct().forEach { id ->
            result[id] = getName(id)
        }
        return result
    }

    /** Полная таблица рейтинга с именами и сводкой — то, что показывает вкладка «Рейтинг». */
    fun getRankBoard(
        personId: String?,
        date: String = MeshCore.today(),
        subjectId: String? = null,
        subjectName: String? = null,
        names: Map<String, String> = emptyMap()
    ): JSONObject {
        val members = getRank(personId, date, subjectId)
        val ids = (0 until members.length())
            .mapNotNull { members.optJSONObject(it)?.optString("personId")?.takeIf { id -> id.isNotBlank() } }
        val resolved = LinkedHashMap(names)
        val missing = ids.filter { !resolved.containsKey(it) }
        if (missing.isNotEmpty()) {
            getNames(missing).forEach { (id, name) -> resolved[id] = name }
        }
        val rows = MeshCore.buildRankTable(members, resolved, personId)
        return JSONObject()
            .put("rows", rows)
            .put("summary", MeshCore.summarizeRank(rows, personId))
            .put("date", date)
            .put("subjectId", subjectId ?: JSONObject.NULL)
            .put("subjectName", subjectName ?: JSONObject.NULL)
    }
}
