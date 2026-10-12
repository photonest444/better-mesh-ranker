package ru.meshrating.app

import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Мост между интерфейсом (WebView) и Kotlin.
 *
 * Со стороны JavaScript это window.MeshNative.invoke(id, method, payloadJson),
 * а ответ приходит вызовом window.__meshResolve(id, json) — ровно так же, как
 * описано в shared/ui/platform.js. Все сетевые запросы выполняются в фоне,
 * UI-поток не блокируется.
 */
class MeshAndroidBridge(
    private val api: MeshApi,
    private val webViewProvider: () -> WebView?,
    private val scope: CoroutineScope
) {

    companion object {
        private const val TAG = "MeshBridge"
        const val NAME = "MeshNative"
    }

    @JavascriptInterface
    fun invoke(id: String, method: String, payloadJson: String) {
        scope.launch(Dispatchers.IO) {
            val envelope = api.handle(method, payloadJson)
            deliver(id, envelope)
        }
    }

    @JavascriptInterface
    fun log(message: String) {
        Log.d(TAG, message)
    }

    /** Отправляет результат в WebView (в UI-потоке). */
    fun deliver(id: String, envelope: JSONObject) {
        post("window.__meshResolve(${JSONObject.quote(id)}, ${JSONObject.quote(envelope.toString())})")
    }

    /** Публикует событие платформы (обновление токена, смена состояния). */
    fun emitEvent(channel: String, payload: JSONObject) {
        post("window.__meshEvent(${JSONObject.quote(channel)}, ${JSONObject.quote(payload.toString())})")
    }

    private fun post(script: String) {
        val webView = webViewProvider() ?: return
        webView.post {
            webView.evaluateJavascript(script, null)
        }
    }
}
