import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

// Every commit raises the version code, so a new APK always installs over the old one as an update.
val commitCount: Int = runCatching {
    providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }.standardOutput.asText.get().trim().toInt()
}.getOrDefault(1)

// The server the app talks to (HTTPS only in release builds). Put `pont.baseUrl=http://your-server:3000` in android/local.properties (git-ignored)
// or pass -Ppont.baseUrl=...; without either, the app points at the Android emulator's host machine.
val baseUrl: String = providers.gradleProperty("pont.baseUrl").orNull
    ?: Properties().apply {
        rootProject.file("local.properties").takeIf { it.exists() }?.reader()?.use { load(it) }
    }.getProperty("pont.baseUrl")
    ?: "http://10.0.2.2:3000"

android {
    namespace = "com.pont.admin"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pont.admin"
        minSdk = 26
        targetSdk = 36
        versionCode = commitCount
        versionName = "0.1.$commitCount"
    }
    buildTypes {
        debug { buildConfigField("String", "DEFAULT_BASE_URL", "\"$baseUrl\"") }
        release {
            isMinifyEnabled = false
            buildConfigField("String", "DEFAULT_BASE_URL", "\"$baseUrl\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation(libs.androidx.core)

    testImplementation(libs.junit)
}
