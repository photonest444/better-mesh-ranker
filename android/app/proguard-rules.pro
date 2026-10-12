# Mesh Ranker — правила ProGuard/R8 для релизной сборки

# Классы, к которым обращаются по имени из WebView (@JavascriptInterface)
-keepclassmembers class ru.meshrating.app.MeshAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class ru.meshrating.app.MeshLoginActivity$LoginBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class ru.meshrating.app.MeshAndroidBridge { *; }

# Ядро и клиент работают с org.json по строковым ключам — сужаем оптимизации
-keep class ru.meshrating.app.MeshCore { *; }
-keep class ru.meshrating.app.MeshClient { *; }
-keep class org.json.** { *; }

# WorkManager создаёт воркер по имени класса
-keep class ru.meshrating.app.TokenRefreshWorker { *; }
-keepclassmembers class * extends androidx.work.Worker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# AndroidX Security (EncryptedSharedPreferences) использует Tink
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# Kotlin metadata и корутины
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontwarn kotlinx.coroutines.**
