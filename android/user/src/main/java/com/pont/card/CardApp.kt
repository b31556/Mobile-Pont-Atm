package com.pont.card

import android.app.Application
import com.pont.card.core.AddCardFlow
import com.pont.card.core.CardsApi
import com.pont.card.core.CardsModel
import com.pont.card.core.CardsRepository
import com.pont.card.core.PlanStore
import com.pont.card.core.PrefsKeyValueStore
import com.pont.card.core.ProgramApi
import com.pont.card.core.ProgramModel
import com.pont.card.core.ProgramRepository
import com.pont.card.core.SnapshotCache
import com.pont.card.core.UidStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** The app's long-lived objects: they outlive the Activity, so turning the phone doesn't lose a request. */
class AppGraph(app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val kv = PrefsKeyValueStore(app)
    val repo = CardsRepository(UidStore(kv), SnapshotCache(kv), CardsApi(BuildConfig.DEFAULT_BASE_URL))
    val model = CardsModel(repo, scope)
    val add = AddCardFlow(repo)
    val program = ProgramModel(ProgramRepository(kv, ProgramApi(BuildConfig.DEFAULT_BASE_URL)), PlanStore(kv), scope)
}

class CardApp : Application() {
    val graph by lazy { AppGraph(this) }
}
