package ru.meshrating.app

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Прикладной слой Android-версии: те же методы, что у Electron (IPC) и
 * web-сервера (REST) — контракт описан в docs/API-CONTRACT.md.
 *
 * Вся логика протокола живёт в MeshCore/MeshClient, здесь — состояние сессии,
 * выбор ученика, демо-режим и сохранение файлов.
 */
class MeshApi(private val context: Context) {

    companion object {
        private const val TAG = "MeshApi"
        val DEFAULT_SETTINGS = mapOf(
            "theme" to "auto",
            "pageSize" to 25,
            "defaultView" to "ranking",
            "denseTables" to false,
            "autoRefreshToken" to true,
            "autoRefreshMinutes" to 0,
            "showHistogram" to true,
            "onlyMyClass" to true
        )
    }

    val store = SessionStore(context)
    private var demoServer: DemoMeshServer? = null
    private var demo = false
    private var client: MeshClient? = null
    private var profile: JSONObject? = null
    private var children: List<JSONObject> = emptyList()
    var activeStudentId: String? = null
        private set
    var lastError: String? = null
        private set

    /** Колбэк для уведомлений об обновлении токена (подписка из MainActivity). */
    var onTokenRefreshed: ((String) -> Unit)? = null
    var onSessionLost: (() -> Unit)? = null

    init {
        if (store.token != null) {
            client = buildClient(store.token, store.profileId)
            activeStudentId = store.studentId
        }
    }

    val isDemo: Boolean get() = demo

    private fun buildClient(token: String?, profileId: String?): MeshClient = MeshClient(
        baseUrl = if (demo) (demoServer?.baseUrl() ?: MeshCore.HOST) else MeshCore.HOST,
        token = token,
        profileId = profileId,
        autoRefresh = store.settings(DEFAULT_SETTINGS)["autoRefreshToken"] as? Boolean ?: true,
        nameCache = store.loadNameCache(),
        onToken = { fresh ->
            // Автосохранение: МЭШ обновил токен в фоне — пользователю ничего делать не нужно
            store.save(fresh, client?.profileId, activeStudentId, store.parentName)
            onTokenRefreshed?.invoke(MeshCore.maskToken(fresh))
            Log.i(TAG, "Токен МЭШ обновлён автоматически")
        }
    )

    // ------------------------------------------------------------ демо-режим ----

    fun setDemo(enabled: Boolean) {
        demo = enabled
        if (enabled) {
            if (demoServer == null) {
                demoServer = DemoMeshServer().also { it.start() }
            }
        }
        client?.baseUrl = if (demo) (demoServer?.baseUrl() ?: MeshCore.HOST) else MeshCore.HOST
    }

    fun demoToken(): JSONObject {
        setDemo(true)
        return JSONObject().put("token", DemoMeshServer.DEMO_TOKEN).put("hint", "Демо-токен локального сервера")
    }

    fun dispose() {
        demoServer?.stop()
        demoServer = null
    }

    // ------------------------------------------------------------------ методы --

    fun stateJson(): JSONObject {
        val token = store.token
        val state = JSONObject()
            .put("demo", demo)
            .put("platform", "android")
            .put("authenticated", token != null)
            .put("token", MeshCore.describeToken(token))
            .put("loginUrl", MeshCore.loginUrl())
            .put("activeStudentId", activeStudentId ?: JSONObject.NULL)
            .put("lastRefresh", if (store.lastRefresh > 0) store.lastRefresh else JSONObject.NULL)
            .put("storage", if (store.isEncrypted()) "encrypted-shared-preferences" else "shared-preferences")
            .put("host", if (demo) "демо-режим (локальные данные)" else MeshCore.HOST)
            .put("settings", settingsJson())
            .put("error", lastError ?: JSONObject.NULL)
        state.put("profile", profile ?: JSONObject.NULL)
        state.put("children", org.json.JSONArray(children))
        return state
    }

    private fun settingsJson(): JSONObject {
        val settings = store.settings(DEFAULT_SETTINGS)
        val json = JSONObject()
        settings.forEach { (key, value) -> if (value != null) json.put(key, value) }
        return json
    }

    fun signIn(rawToken: String): JSONObject {
        val result = ensureClient().signIn(rawToken)
        profile = result.optJSONObject("profile")
        children = extractChildren(profile)
        activeStudentId = result.optJSONObject("child")?.optString("id")?.takeIf { it.isNotBlank() }
        store.save(result.optString("token"), activeStudentId, activeStudentId, profile?.optJSONObject("parent")?.optString("name"))
        lastError = null
        return stateJson()
    }

    fun signOut(): JSONObject {
        store.clear()
        client = null
        profile = null
        children = emptyList()
        activeStudentId = null
        return stateJson()
    }

    fun refreshToken(): JSONObject {
        val fresh = ensureClient().refreshToken()
            ?: throw MeshCore.MeshError("МЭШ не выдал новый токен — войдите заново", "refresh-failed")
        store.save(fresh, client?.profileId, activeStudentId, store.parentName)
        return stateJson()
    }

    fun selectStudent(studentId: String): JSONObject {
        val child = children.firstOrNull { it.optString("id") == studentId }
            ?: throw MeshCore.MeshError("Ученик не найден", "not-found")
        activeStudentId = child.optString("id")
        client?.profileId = activeStudentId
        store.studentId = activeStudentId
        return stateJson()
    }

    fun loadProfile(): JSONObject {
        val normalized = ensureClient().fetchProfile()
        profile = normalized
        children = extractChildren(normalized)
        if (activeStudentId.isNullOrBlank()) {
            activeStudentId = children.firstOrNull()?.optString("id")
            client?.profileId = activeStudentId
        }
        return stateJson()
    }

    fun subjects(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        val date = params?.optString("date")?.takeIf { it.isNotBlank() } ?: MeshCore.today()
        return JSONObject()
            .put("date", date)
            .put("personId", child.optString("personId"))
            .put("subjects", ensureClient().getSubjects(child.optString("personId"), date))
    }

    fun subjectMarks(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        return JSONObject().put("marks", ensureClient().getSubjectMarks(child.optString("id")))
    }

    fun rank(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        val date = params?.optString("date")?.takeIf { it.isNotBlank() } ?: MeshCore.today()
        val subjectId = params?.optString("subjectId")?.takeIf { it.isNotBlank() && it != "null" }
        val board = ensureClient().getRankBoard(
            personId = child.optString("personId"),
            date = date,
            subjectId = subjectId,
            subjectName = params?.optString("subjectName")?.takeIf { it.isNotBlank() }
        )
        store.saveNameCache(client?.nameCache ?: emptyMap())
        return board
    }

    fun marks(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        val to = params?.optString("to")?.takeIf { it.isNotBlank() } ?: MeshCore.today()
        val from = params?.optString("from")?.takeIf { it.isNotBlank() } ?: MeshCore.addDays(to, -30)
        val list = ensureClient().getMarks(child.optString("id"), from, to)
        return JSONObject()
            .put("from", from)
            .put("to", to)
            .put("marks", org.json.JSONArray(list))
            .put("summary", MeshCore.summarizeMarks(list))
    }

    fun homeworks(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        val to = params?.optString("to")?.takeIf { it.isNotBlank() } ?: MeshCore.today()
        val from = params?.optString("from")?.takeIf { it.isNotBlank() } ?: MeshCore.addDays(to, -7)
        val list = ensureClient().getHomeworks(child.optString("id"), from, to)
        return JSONObject().put("from", from).put("to", to).put("homeworks", org.json.JSONArray(list))
    }

    fun schedule(params: JSONObject?): JSONObject {
        val child = studentFrom(params)
        val date = params?.optString("date")?.takeIf { it.isNotBlank() } ?: MeshCore.today()
        return JSONObject().put("date", date).put("lessons", ensureClient().getSchedule(child.optString("id"), date))
    }

    fun names(personIds: String?): JSONObject {
        val ids = personIds?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
        val resolved = ensureClient().getNames(ids)
        store.saveNameCache(client?.nameCache ?: emptyMap())
        val json = JSONObject()
        resolved.forEach { (key, value) -> json.put(key, value) }
        return JSONObject().put("names", json)
    }

    fun clearCache(): JSONObject {
        store.saveNameCache(emptyMap())
        client?.nameCache?.clear()
        return JSONObject().put("cleared", true)
    }

    fun settingsGet(): JSONObject = settingsJson()

    fun settingsSet(patch: JSONObject?): JSONObject {
        if (patch != null) {
            val map = mutableMapOf<String, Any?>()
            patch.keys().forEach { key -> map[key] = patch.opt(key) }
            store.saveSettings(map)
            client?.autoRefresh = store.settings(DEFAULT_SETTINGS)["autoRefreshToken"] as? Boolean ?: true
        }
        return settingsJson()
    }

    /** Сохранение экспорта (CSV/JSON) в папку приложения «Загрузки». */
    fun saveFile(fileName: String?, text: String?): JSONObject {
        val safeName = (fileName ?: "mesh-export.csv").replace(Regex("[^A-Za-z0-9._-]"), "_")
        val dir = context.getExternalFilesDir(null) ?: context.filesDir
        val file = File(dir, safeName)
        file.writeText(text ?: "", Charsets.UTF_8)
        return JSONObject().put("saved", true).put("filePath", file.absolutePath)
    }

    /** Проверка соединения — используется в настройках и фоновым обновлением. */
    fun ping(): JSONObject {
        return try {
            ensureClient().fetchProfile()
            JSONObject().put("ok", true)
        } catch (error: Exception) {
            lastError = MeshCore.describeError(error)
            throw error
        }
    }

    /** Периодическая задача: обновить токен, чтобы сессия не «остывала». */
    fun refreshTokenSilently(): Boolean {
        val token = store.token ?: return false
        return try {
            val fresh = buildClient(token, store.profileId).refreshToken()
            if (fresh != null) {
                store.save(fresh, store.profileId, store.studentId, store.parentName)
                true
            } else {
                false
            }
        } catch (error: Exception) {
            Log.w(TAG, "Не удалось обновить токен в фоне: ${error.message}")
            false
        }
    }

    /** Текущий заголовок для уведомления: имя активного ученика. */
    fun activeStudentName(): String? = studentOrNull()?.optString("name")

    // ----------------------------------------------------------------- служебное --

    private fun ensureClient(): MeshClient {
        val existing = client
        if (existing != null) return existing
        val token = store.token ?: throw MeshCore.MeshError("Требуется вход в МЭШ", "unauthorized", 401)
        val created = buildClient(token, store.profileId)
        client = created
        return created
    }

    private fun extractChildren(profileJson: JSONObject?): List<JSONObject> {
        val array = profileJson?.optJSONArray("children") ?: return emptyList()
        return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }

    private fun studentOrNull(): JSONObject? =
        children.firstOrNull { it.optString("id") == activeStudentId } ?: children.firstOrNull()

    private fun studentFrom(params: JSONObject?): JSONObject {
        val requested = params?.optString("studentId")?.takeIf { it.isNotBlank() }
        if (requested != null) {
            children.firstOrNull { it.optString("id") == requested }?.let { return it }
        }
        return studentOrNull() ?: throw MeshCore.MeshError("Не выбран ученик", "no-student")
    }

    /**
     * Единая точка входа: method + JSON-параметры → JSON-ответ.
     * Возвращает конверт {ok, data} либо {ok:false, error}.
     */
    fun handle(method: String, payloadJson: String?): JSONObject {
        val payload = try {
            if (payloadJson.isNullOrBlank()) JSONObject() else JSONObject(payloadJson)
        } catch (error: Exception) {
            JSONObject()
        }
        return try {
            val data: Any = when (method) {
                "state" -> stateJson()
                "signIn" -> signIn(payload.optString("token"))
                "signOut" -> signOut()
                "refreshToken" -> refreshToken()
                "selectStudent" -> selectStudent(payload.optString("studentId"))
                "profile" -> loadProfile()
                "subjects" -> subjects(payload)
                "subjectMarks" -> subjectMarks(payload)
                "rank" -> rank(payload)
                "marks" -> marks(payload)
                "homeworks" -> homeworks(payload)
                "schedule" -> schedule(payload)
                "names" -> names(payload.optString("personIds"))
                "demoToken" -> demoToken()
                "clearCache" -> clearCache()
                "settingsGet" -> settingsGet()
                "settingsSet" -> settingsSet(payload)
                "saveFile" -> saveFile(payload.optString("fileName"), payload.optString("text"))
                "ping" -> ping()
                "loginUrl" -> JSONObject().put("url", MeshCore.loginUrl())
                else -> throw MeshCore.MeshError("Неизвестный метод: $method", "not-found")
            }
            JSONObject().put("ok", true).put("data", data)
        } catch (error: Exception) {
            if (error is MeshCore.MeshError && error.code == "unauthorized") onSessionLost?.invoke()
            lastError = MeshCore.describeError(error)
            JSONObject().put(
                "ok",
                false
            ).put(
                "error",
                JSONObject()
                    .put("code", (error as? MeshCore.MeshError)?.code ?: "error")
                    .put("message", MeshCore.describeError(error))
                    .put("raw", error.message ?: error.toString())
            )
        }
    }

    /** Время последнего успешного обращения (для диагностики на вкладке «Профиль»). */
    fun lastRefreshIso(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(store.lastRefresh))
}
