package com.pont.atm.ui

import com.pont.atm.core.ApiException
import com.pont.atm.core.PresetConfig
import com.pont.atm.core.PresetsApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class PresetsViewModelTest {
    private class Fake(var stored: PresetConfig = PresetConfig(listOf(4, 8, 12, 20), true), var fail: Boolean = false) : PresetsApi {
        override suspend fun presets() = Result.success(stored)
        override suspend fun savePresets(values: List<Int>, instantPreset: Boolean): Result<PresetConfig> {
            if (fail) return Result.failure(ApiException("No connection to the server.", "no_connection"))
            stored = PresetConfig(values, instantPreset); return Result.success(stored)
        }
    }

    @Test fun addingKeepsTheListSorted() = runBlocking {
        val vm = PresetsViewModel(Fake()); vm.load()
        assertEquals(true, vm.add("5"))
        assertEquals(listOf(4, 5, 8, 12, 20), vm.values)
    }

    @Test fun aDuplicateIsRefusedWithAMessage() = runBlocking {
        val vm = PresetsViewModel(Fake()); vm.load()
        assertEquals(false, vm.add("8"))
        assertEquals("That preset already exists.", vm.message)
    }

    @Test fun junkAndOutOfRangeAreRefused() = runBlocking {
        val vm = PresetsViewModel(Fake()); vm.load()
        for (bad in listOf("", "abc", "0", "10000", "1.5")) assertEquals("input '$bad'", false, vm.add(bad))
        assertEquals("Enter a whole number from 1 to 9999.", vm.message)
        assertEquals(listOf(4, 8, 12, 20), vm.values)
    }

    @Test fun aNinthPresetIsRefused() = runBlocking {
        val vm = PresetsViewModel(Fake(PresetConfig((1..8).toList(), true))); vm.load()
        assertEquals(false, vm.add("9"))
        assertEquals("Up to 8 presets.", vm.message)
    }

    @Test fun removeAndTheSwitchAreSaved() = runBlocking {
        val api = Fake(); val vm = PresetsViewModel(api); vm.load()
        vm.remove(4); vm.setInstant(false)
        assertEquals(PresetConfig(listOf(8, 12, 20), false), api.stored)
    }

    @Test fun aFailedSaveKeepsTheOldListAndShowsWhy() = runBlocking {
        val vm = PresetsViewModel(Fake(fail = true)); vm.load()
        assertEquals(false, vm.remove(4))
        assertEquals(listOf(4, 8, 12, 20), vm.values)
        assertEquals("No connection to the server.", vm.message)
    }
}
