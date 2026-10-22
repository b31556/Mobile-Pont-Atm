package com.pont.atm.ui

import com.pont.atm.core.ApiException
import com.pont.atm.core.CardInfo
import com.pont.atm.core.CardRef
import com.pont.atm.core.HistoryApi
import com.pont.atm.core.StornoResult
import com.pont.atm.core.Tx
import com.pont.atm.core.TxInfo
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryViewModelTest {
    private fun tx(id: Long, type: String = "give", status: String = "ok", amount: Int = 8) =
        Tx(id, type, amount, status, null, "2026-10-22T14:32:00.000Z", "Bar 2", "Eszter", CardRef("c1", "Anna Kovács", "/cards/c1/photo"))

    private class Fake(var rows: List<Tx>, var storno: Result<StornoResult>) : HistoryApi {
        override suspend fun history() = Result.success(rows)
        override suspend fun storno(id: Long) = storno
    }
    private val stornoOk = Result.success(StornoResult(TxInfo(9, -8, "x", "Bar 2"), CardInfo("c1", "Anna Kovács", "/p", 54, 46)))

    @Test fun loadShowsChargesOnlyNewestFirst() = runBlocking {
        val vm = HistoryViewModel(Fake(listOf(tx(3, "storno", amount = -8), tx(2), tx(1)), stornoOk))
        vm.load()
        assertEquals(listOf(2L, 1L), vm.rows.map { it.id })
    }

    @Test fun confirmingStornoMarksTheRowAndReportsTheBalance() = runBlocking {
        val vm = HistoryViewModel(Fake(listOf(tx(2)), stornoOk)); vm.load()
        vm.open(2); vm.askStorno()
        assertEquals(true, vm.confirming)
        vm.confirmStorno()
        assertEquals("stornoed", vm.rows.single().status)
        assertEquals("Stornoed. Anna Kovács now has 46 points.", vm.message)
        assertNull(vm.target)
    }

    @Test fun aRefusedStornoLeavesTheRowAndShowsTheServerMessage() = runBlocking {
        val refused = Result.failure<StornoResult>(ApiException("Card has fewer points than this storno.", "would_go_negative", 400))
        val vm = HistoryViewModel(Fake(listOf(tx(2)), refused)); vm.load()
        vm.open(2); vm.askStorno(); vm.confirmStorno()
        assertEquals("ok", vm.rows.single().status)
        assertEquals("Card has fewer points than this storno.", vm.message)
    }

    @Test fun dismissClosesTheSheet() = runBlocking {
        val vm = HistoryViewModel(Fake(listOf(tx(2)), stornoOk)); vm.load()
        vm.open(2); vm.askStorno(); vm.dismiss()
        assertNull(vm.target); assertEquals(false, vm.confirming)
    }
}
