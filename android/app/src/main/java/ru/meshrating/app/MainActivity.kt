package ru.meshrating.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import ru.meshrating.app.databinding.ActivityMainBinding

/**
 * Главный экран Android-версии: WebView с общим интерфейсом (shared/ui)
 * и нативное меню (обновить, вход, демо-режим, выход).
 *
 * Все данные приложение получает через MeshAndroidBridge → MeshApi → MeshClient.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val UI_URL = "file:///android_asset/ui/index.html"
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var api: MeshApi
    private lateinit var bridge: MeshAndroidBridge
    private val scope = CoroutineScope(Dispatchers.Main + Job())

    private val loginLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) {
            Toast.makeText(this, "Вход отменён", Toast.LENGTH_SHORT).show()
            return@registerForActivityResult
        }
        val token = result.data?.getStringExtra(MeshLoginActivity.EXTRA_TOKEN) ?: return@registerForActivityResult
        val source = result.data?.getStringExtra(MeshLoginActivity.EXTRA_SOURCE) ?: "МЭШ"
        signIn(token, source)
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        api = MeshApi(this)
        api.onTokenRefreshed = { mask ->
            // Токен обновился автоматически — сообщаем интерфейсу и обновляем заголовок
            bridge.emitEvent("token", JSONObject().put("mask", mask))
        }
        api.onSessionLost = { bridge.emitEvent("status", JSONObject().put("message", "Сессия МЭШ истекла — войдите заново").put("type", "error")) }

        bridge = MeshAndroidBridge(api, { binding.webView }, scope)
        setupWebView()
        requestNotificationPermission()
        binding.retryButton.setOnClickListener {
            binding.offlinePanel.visibility = View.GONE
            binding.webView.reload()
        }
    }

    private fun setupWebView() {
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            setSupportZoom(false)
            builtInZoomControls = false
            mediaPlaybackRequiresUserGesture = true
        }
        @Suppress("DEPRECATION")
        binding.webView.settings.allowFileAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        binding.webView.settings.allowUniversalAccessFromFileURLs = true

        binding.webView.addJavascriptInterface(bridge, MeshAndroidBridge.NAME)
        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                binding.progress.visibility = View.GONE
                updateTitle()
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    binding.offlinePanel.visibility = View.VISIBLE
                    binding.progress.visibility = View.GONE
                }
            }
        }
        binding.webView.loadUrl(UI_URL)
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            if (granted != PackageManager.PERMISSION_GRANTED) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun updateTitle() {
        val name = api.activeStudentName()
        supportActionBar?.title = if (api.isDemo) {
            "${getString(R.string.app_name)} · ${getString(R.string.demo_badge)}"
        } else if (name != null) {
            "${getString(R.string.app_name)} · $name"
        } else {
            getString(R.string.app_name)
        }
        invalidateOptionsMenu()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        menu.findItem(R.id.action_demo)?.isChecked = api.isDemo
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_refresh -> {
                binding.progress.visibility = View.VISIBLE
                binding.webView.reload()
                return true
            }
            R.id.action_login -> {
                loginLauncher.launch(Intent(this, MeshLoginActivity::class.java))
                return true
            }
            R.id.action_refresh_token -> {
                refreshToken()
                return true
            }
            R.id.action_demo -> {
                item.isChecked = !item.isChecked
                api.setDemo(item.isChecked)
                Toast.makeText(this, if (item.isChecked) "Демо-режим включён" else "Демо-режим выключен", Toast.LENGTH_SHORT).show()
                updateTitle()
                binding.webView.reload()
                return true
            }
            R.id.action_sign_out -> {
                confirmSignOut()
                return true
            }
            R.id.action_open_mesh -> {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(MeshCore.loginUrl())))
                return true
            }
            R.id.action_about -> {
                AlertDialog.Builder(this)
                    .setTitle(getString(R.string.about_title))
                    .setMessage(
                        getString(R.string.about_message) +
                            "\n\nХранилище токена: " + (if (api.store.isEncrypted()) "шифрованное (Android Keystore)" else "приватное хранилище приложения") +
                            "\nПлатформа: Android ${Build.VERSION.RELEASE}"
                    )
                    .setPositiveButton(R.string.about_close, null)
                    .show()
                return true
            }
        }
        return super.onOptionsItemSelected(item)
    }

    private fun signIn(token: String, source: String) {
        binding.progress.visibility = View.VISIBLE
        scope.launch {
            val envelope = withContext(Dispatchers.IO) { api.handle("signIn", JSONObject().put("token", token).toString()) }
            binding.progress.visibility = View.GONE
            if (envelope.optBoolean("ok")) {
                Toast.makeText(this@MainActivity, "Вход выполнен ($source)", Toast.LENGTH_SHORT).show()
                updateTitle()
                bridge.emitEvent("state", api.stateJson())
                binding.webView.reload()
            } else {
                val message = envelope.optJSONObject("error")?.optString("message") ?: "Не удалось войти"
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun refreshToken() {
        binding.progress.visibility = View.VISIBLE
        scope.launch {
            val envelope = withContext(Dispatchers.IO) { api.handle("refreshToken", "{}") }
            binding.progress.visibility = View.GONE
            val message = if (envelope.optBoolean("ok")) "Токен обновлён" else envelope.optJSONObject("error")?.optString("message") ?: "Не удалось обновить токен"
            Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            if (envelope.optBoolean("ok")) bridge.emitEvent("state", api.stateJson())
        }
    }

    private fun confirmSignOut() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.menu_sign_out))
            .setMessage("Удалить сохранённый токен МЭШ с этого устройства?")
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                api.handle("signOut", "{}")
                Toast.makeText(this, "Вы вышли из МЭШ", Toast.LENGTH_SHORT).show()
                updateTitle()
                binding.webView.reload()
            }
            .show()
    }

    @Deprecated("Устаревший API, но нужен для WebView-навигации")
    override fun onBackPressed() {
        if (binding.webView.canGoBack()) binding.webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        binding.webView.removeJavascriptInterface(MeshAndroidBridge.NAME)
        api.dispose()
        super.onDestroy()
    }
}
