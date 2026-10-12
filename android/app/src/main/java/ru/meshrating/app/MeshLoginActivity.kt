package ru.meshrating.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Вход в МЭШ: WebView открывает страницу refresh-токена, а встроенный скрипт
 * перехватывает токен из адреса, localStorage и ответов сети. Как только токен
 * найден — окно закрывается и токен уходит в MainActivity.
 */
class MeshLoginActivity : AppCompatActivity() {

    /** Мост для страницы входа: сюда приходят «сигналы» о токене. */
    private inner class LoginBridge {
        @JavascriptInterface
        fun signal(json: String) {
            val candidate = MeshCore.extractToken(json)
            if (candidate != null) finishWithToken(candidate, "страница МЭШ")
        }

        @JavascriptInterface
        fun log(message: String) {
            Log.d(TAG, message)
        }
    }

    companion object {
        private const val TAG = "MeshLogin"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_SOURCE = "source"
    }

    private lateinit var webView: WebView
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        supportActionBar?.apply {
            setDisplayHomeAsUpEnabled(true)
            title = getString(R.string.login_title)
        }

        webView = findViewById(R.id.loginWebView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            userAgentString = MeshCore.USER_AGENT
        }
        webView.addJavascriptInterface(LoginBridge(), "MeshAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                url?.let { check(it, "навигация") }
                view?.evaluateJavascript(CAPTURE_SCRIPT + "\nMeshAndroid.log('capture: ' + location.href);", null)
                view?.evaluateJavascript("document.body ? document.body.innerText.substring(0, 20000) : ''") { text ->
                    if (text != null) check(text.trim('"').replace("\\n", "\n"), "страница")
                }
            }
        }
        webView.loadUrl(MeshCore.loginUrl())

        // Периодическая проверка: localStorage и адрес
        scope.launch {
            while (isActive && !finished) {
                delay(1500)
                if (finished) break
                webView.evaluateJavascript(SCAN_SCRIPT) { result ->
                    if (result != null && result != "null") check(result.trim('"').replace("\\\"", "\""), "localStorage")
                }
            }
        }
    }

    private fun check(candidate: String?, source: String) {
        if (candidate.isNullOrBlank() || finished) return
        val token = MeshCore.extractToken(candidate) ?: return
        finishWithToken(token, source)
    }

    private fun finishWithToken(token: String, source: String) {
        if (finished) return
        finished = true
        Toast.makeText(this, "Токен МЭШ получен", Toast.LENGTH_SHORT).show()
        setResult(
            Activity.RESULT_OK,
            Intent().putExtra(EXTRA_TOKEN, token).putExtra(EXTRA_SOURCE, source)
        )
        finish()
    }

    override fun onSupportNavigateUp(): Boolean {
        if (webView.canGoBack()) webView.goBack() else finish()
        return true
    }

    override fun onDestroy() {
        webView.removeJavascriptInterface("MeshAndroid")
        super.onDestroy()
    }
}

/** Скрипт-перехватчик: ловит токен в localStorage, fetch и XHR. */
private const val CAPTURE_SCRIPT = """
(function () {
  if (window.__meshCaptureInstalled) return;
  window.__meshCaptureInstalled = true;
  function send(value) {
    try { MeshAndroid.signal(String(value)); } catch (error) {}
  }
  try {
    var originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      var result = originalSet.apply(this, arguments);
      if (value !== undefined && value !== null) send(value);
      return result;
    };
  } catch (error) {}
  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        var args = arguments;
        return originalFetch.apply(this, args).then(function (response) {
          try {
            if (/token|auth|session|login|profile/i.test(response.url || '')) {
              response.clone().text().then(send).catch(function () {});
            }
          } catch (error) {}
          return response;
        });
      };
    }
  } catch (error) {}
  try {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__meshUrl = url; return originalOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        try {
          if (/token|auth|session|login|profile/i.test(String(this.__meshUrl || ''))) send(this.responseText);
        } catch (error) {}
      });
      return originalSend.apply(this, arguments);
    };
  } catch (error) {}
})();
"""

/** Скрипт-опрос: возвращает значение из localStorage или адрес страницы. */
private const val SCAN_SCRIPT = """
(function () {
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      var value = localStorage.getItem(key) || '';
      if (/token/i.test(key) || value.length > 24) return value;
    }
  } catch (error) {}
  return location.href.indexOf('token=') >= 0 ? location.href : null;
})();
"""
