package ru.meshrating.app

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Хранилище сессии на Android.
 *
 * Токен МЭШ лежит в EncryptedSharedPreferences (ключ шифрования — в Android Keystore),
 * кэш имён и настройки — в обычных приватных SharedPreferences. Если шифрование
 * недоступно (например, на устройстве без Keystore), используется обычное приватное
 * хранилище приложения с предупреждением в лог.
 */
class SessionStore(context: Context) {

    companion object {
        private const val TAG = "MeshSession"
        private const val SESSION_FILE = "mesh_session"
        private const val CACHE_FILE = "mesh_cache"
        private const val SETTINGS_FILE = "mesh_settings"

        private const val KEY_TOKEN = "token"
        private const val KEY_PROFILE_ID = "profileId"
        private const val KEY_STUDENT_ID = "studentId"
        private const val KEY_PARENT_NAME = "parentName"
        private const val KEY_NAMES = "names"
        private const val KEY_LAST_REFRESH = "lastRefresh"
    }

    private val appContext = context.applicationContext
    private var encrypted: Boolean = false
    private val session: SharedPreferences = createSessionPrefs(appContext)
    private val cache: SharedPreferences = appContext.getSharedPreferences(CACHE_FILE, Context.MODE_PRIVATE)
    private val settings: SharedPreferences = appContext.getSharedPreferences(SETTINGS_FILE, Context.MODE_PRIVATE)

    private fun createSessionPrefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context,
                SESSION_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            encrypted = true
            prefs
        } catch (error: Exception) {
            Log.w(TAG, "Шифрованное хранилище недоступно, используется приватное: ${error.message}")
            encrypted = false
            context.getSharedPreferences(SESSION_FILE, Context.MODE_PRIVATE)
        }
    }

    /** Признак того, что токен защищён ключом устройства. */
    fun isEncrypted(): Boolean = encrypted

    var token: String?
        get() = session.getString(KEY_TOKEN, null)
        set(value) {
            session.edit().apply {
                if (value.isNullOrBlank()) remove(KEY_TOKEN) else putString(KEY_TOKEN, value)
            }.apply()
        }

    var profileId: String?
        get() = session.getString(KEY_PROFILE_ID, null)
        set(value) {
            session.edit().putString(KEY_PROFILE_ID, value).apply()
        }

    var studentId: String?
        get() = session.getString(KEY_STUDENT_ID, null)
        set(value) {
            session.edit().putString(KEY_STUDENT_ID, value).apply()
        }

    var parentName: String?
        get() = session.getString(KEY_PARENT_NAME, null)
        set(value) {
            session.edit().putString(KEY_PARENT_NAME, value).apply()
        }

    var lastRefresh: Long
        get() = session.getLong(KEY_LAST_REFRESH, 0L)
        set(value) {
            session.edit().putLong(KEY_LAST_REFRESH, value).apply()
        }

    /** Токен + кэш обновляются одной транзакцией — после входа/обновления токена. */
    fun save(token: String?, profileId: String?, studentId: String?, parentName: String?) {
        session.edit().apply {
            if (token != null) putString(KEY_TOKEN, token)
            if (profileId != null) putString(KEY_PROFILE_ID, profileId)
            if (studentId != null) putString(KEY_STUDENT_ID, studentId)
            if (parentName != null) putString(KEY_PARENT_NAME, parentName)
            putLong(KEY_LAST_REFRESH, System.currentTimeMillis())
        }.apply()
    }

    fun clear() {
        session.edit().clear().apply()
    }

    // --------------------------------------------------------------- кэш имён --

    fun loadNameCache(): MutableMap<String, String> {
        val raw = cache.getString(KEY_NAMES, null) ?: return mutableMapOf()
        return try {
            val json = JSONObject(raw)
            val result = mutableMapOf<String, String>()
            json.keys().forEach { key -> result[key] = json.optString(key) }
            result
        } catch (error: Exception) {
            mutableMapOf()
        }
    }

    fun saveNameCache(names: Map<String, String>) {
        val json = JSONObject()
        names.forEach { (key, value) -> json.put(key, value) }
        cache.edit().putString(KEY_NAMES, json.toString()).apply()
    }

    // -------------------------------------------------------------- настройки --

    fun settings(defaults: Map<String, Any?>): Map<String, Any?> {
        val result = mutableMapOf<String, Any?>()
        defaults.forEach { (key, fallback) ->
            result[key] = when (fallback) {
                is Boolean -> settings.getBoolean(key, fallback)
                is Int -> settings.getInt(key, fallback)
                is Long -> settings.getLong(key, fallback)
                else -> settings.getString(key, fallback?.toString())
            }
        }
        return result
    }

    fun saveSettings(patch: Map<String, Any?>) {
        settings.edit().apply {
            patch.forEach { (key, value) ->
                when (value) {
                    is Boolean -> putBoolean(key, value)
                    is Int -> putInt(key, value)
                    is Long -> putLong(key, value)
                    null -> remove(key)
                    else -> putString(key, value.toString())
                }
            }
        }.apply()
    }
}
