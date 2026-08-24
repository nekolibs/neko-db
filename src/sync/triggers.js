import { AppState } from 'react-native'

import { getEmitter, getModels } from '../models'
import { sync, push } from './engine'
import { getPushes, pushDefsForModel } from './registry'
import { syncLog } from './log'

// Optional peer — apps that want reconnect-triggered syncs install it
// (npx expo install @react-native-community/netinfo). Absent = degrade quietly.
function tryRequireNetInfo() {
  try {
    const mod = require('@react-native-community/netinfo')
    return mod?.default ?? mod
  } catch (error) {
    return null
  }
}

// Wires every scheduling trigger; returns a stop() that removes them all.
// The engine mutex makes overlapping triggers safe (extra calls queue one rerun).
export function startTriggers(config = {}) {
  const {
    syncOnStart = true,
    interval = 900, // seconds (15min); 0/false disables — foreground/reconnect triggers cover most refresh needs
    debouncePush = 2, // seconds; 0/false disables
    cooldown = 30, // seconds; full cycles skip when the last one finished sooner — 0 disables
  } = config

  const cleanups = []

  if (syncOnStart) {
    syncLog('trigger: syncOnStart')
    sync()
  }

  // App returns to foreground
  const appStateSub = AppState?.addEventListener?.('change', (state) => {
    if (state === 'active') {
      syncLog('trigger: AppState active')
      sync({ cooldown })
    }
  })
  if (appStateSub?.remove) cleanups.push(() => appStateSub.remove())

  // Connectivity restored
  const NetInfo = tryRequireNetInfo()
  if (NetInfo?.addEventListener) {
    let wasConnected = null
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = !!state.isConnected
      if (wasConnected === false && connected) {
        syncLog('trigger: NetInfo reconnect')
        sync({ cooldown })
      }
      wasConnected = connected
    })
    cleanups.push(unsubscribe)
  }

  // Periodic while foregrounded
  if (interval) {
    const timer = setInterval(() => {
      if (!AppState?.currentState || AppState.currentState === 'active') {
        syncLog('trigger: interval')
        sync({ cooldown })
      }
    }, interval * 1000)
    cleanups.push(() => clearInterval(timer))
  }

  // Per-def debounced push after local writes. A scoped push carries each def's
  // transitive dependsOn closure — pickDefs treats deps outside the picked subset as
  // satisfied, so pushing a def alone would skip an upstream it must follow.
  if (debouncePush) {
    const emitter = getEmitter()
    const syncedModels = Object.values(getModels()).filter((model) => model.sync)

    if (emitter && syncedModels.length > 0) {
      const closureOf = (defId) => {
        const pushes = getPushes()
        const ids = new Set()
        const visit = (id) => {
          if (ids.has(id) || !pushes[id]) return
          ids.add(id)
          ;(pushes[id].dependsOn || []).forEach(visit)
        }
        visit(defId)
        return [...ids]
      }

      const timers = new Map()
      const schedule = (defId, seconds) => {
        if (timers.has(defId)) clearTimeout(timers.get(defId))
        timers.set(
          defId,
          setTimeout(() => {
            timers.delete(defId)
            syncLog('trigger: debounced push', defId)
            push({ ids: closureOf(defId) })
          }, seconds * 1000)
        )
      }

      syncedModels.forEach((model) => {
        cleanups.push(
          emitter.subscribe(model.name, () => {
            pushDefsForModel(model.name).forEach((def) => {
              if (def.autoPush === false) return
              schedule(def.id, def.debounce ?? debouncePush)
            })
          })
        )
      })
      cleanups.push(() => timers.forEach((timer) => clearTimeout(timer)))
    }
  }

  return () => cleanups.forEach((fn) => fn())
}
