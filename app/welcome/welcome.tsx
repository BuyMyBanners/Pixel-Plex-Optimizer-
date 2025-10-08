import React from "react"
import { optimizeBlockIncome } from "./optimize"
import { optimizeBlockIncomeFromDefinitions } from "./optimize"

export function Welcome() {
  async function runOptimizer() {
    try {
      // load data-file.json (served from public or repo root depending on dev server config)
      const res = await fetch("./data-file.json")
      if (!res.ok) throw new Error(`Failed to load data-file.json: ${res.status}`)
      const defs = await res.json()

      const result = optimizeBlockIncomeFromDefinitions(defs, 16, { debug: true, beamWidth: 800 })
      console.log("Optimizer result:", result)
    } catch (e) {
      console.error("Optimizer failed:", e)
    }
  }

  return (
    <main className="flex items-center justify-center pt-16 pb-4">
      <div className="flex-1 flex flex-col items-center gap-16 min-h-0">
        <div className="max-w-[300px] w-full space-y-6 px-4">
          <nav className="rounded-3xl border border-gray-200 p-6 dark:border-gray-700 space-y-4">
            <p className="leading-6 text-gray-700 dark:text-gray-200 text-center">What&apos;s next?</p>
            <div className="flex flex-col gap-3">
              <button onClick={runOptimizer} className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700">
                Run optimizer (console)
              </button>
            </div>
          </nav>
        </div>
      </div>
    </main>
  )
}
