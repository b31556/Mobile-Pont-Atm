package com.pont.atm

import android.app.Application

class PontApp : Application() {
    val graph by lazy { AppGraph(this) }
}
