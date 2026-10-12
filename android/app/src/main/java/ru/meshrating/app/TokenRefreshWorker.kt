package ru.meshrating.app

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Фоновое продление сессии МЭШ.
 *
 * Раз в 12 часов (по расписанию из MeshApp) приложение запрашивает новый токен.
 * Если МЭШ отказывает — приходит уведомление «нужен повторный вход».
 */
class TokenRefreshWorker(
    context: Context,
    params: WorkerParameters
) : Worker(context, params) {

    companion object {
        const val WORK_NAME = "mesh-token-refresh"
        private const val TAG = "TokenRefreshWorker"
        private const val NOTIFICATION_ID = 3101
    }

    override fun doWork(): Result {
        val api = MeshApi(applicationContext)
        val hadToken = api.store.token != null
        if (!hadToken) return Result.success()

        return try {
            val token = api.store.token
            val client = MeshClient(
                token = token,
                profileId = api.store.profileId,
                onToken = { fresh ->
                    api.store.save(fresh, api.store.profileId, api.store.studentId, api.store.parentName)
                }
            )
            val fresh = client.refreshToken()
            if (fresh != null) {
                notify(
                    applicationContext.getString(R.string.notif_token_title),
                    applicationContext.getString(R.string.notif_token_text)
                )
                Result.success()
            } else {
                notify(
                    applicationContext.getString(R.string.notif_error_title),
                    applicationContext.getString(R.string.notif_error_text)
                )
                Result.retry()
            }
        } catch (error: Exception) {
            Log.w(TAG, "Фоновое обновление не удалось: ${error.message}")
            Result.retry()
        }
    }

    private fun notify(title: String, text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS)
            if (granted != PackageManager.PERMISSION_GRANTED) return
        }
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val intent = PendingIntent.getActivity(
            applicationContext,
            0,
            Intent(applicationContext, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(applicationContext, MeshApp.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mesh)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(intent)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }
}
