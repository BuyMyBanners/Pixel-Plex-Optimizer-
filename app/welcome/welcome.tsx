import React, { useState } from "react"
import { optimizeMultipleBlocks } from "./optimize"

type OptimizerResult = {
  blocks: Array<{
    blockNumber: number
    combination: Array<{
      name: string
      level: number
      count: number
      size: number
      incomePerBuilding: number
      totalIncome: number
      totalSize: number
      type: string
      workerType: string | null
    }>
    totalIncome: number
    totalSize: number
    averageEfficiencyByType: Record<string, string>
  }>
  aggregateTotalIncome: number
  aggregateTotalStorage: {
    money: number
    wood: number
    cement: number
    steel: number
  }
  baseStorage: {
    money: number
    wood: number
    cement: number
    steel: number
  }
}

export function Welcome() {
  const [numBlocksInput, setNumBlocksInput] = useState("3")
  const [sizeLimitInput, setSizeLimitInput] = useState("16")
  const [beamWidthInput, setBeamWidthInput] = useState("400")
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<OptimizerResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runOptimizer() {
    setIsLoading(true)
    setError(null)
    setResult(null)

    const numBlocks = Math.max(1, parseInt(numBlocksInput) || 1)
    const sizeLimit = Math.max(1, parseInt(sizeLimitInput) || 16)
    const beamWidth = Math.max(100, parseInt(beamWidthInput) || 400)

    try {
      const defs = await fetch("/data-file.json").then((r) => r.json())

      setTimeout(() => {
        const optimizerResult = optimizeMultipleBlocks(defs, numBlocks, sizeLimit, {
          debug: false,
          beamWidth: beamWidth,
        })

        if (optimizerResult) {
          setResult(optimizerResult as OptimizerResult)
        } else {
          setError("No valid solution found. Try increasing block size or reducing constraints.")
        }
        setIsLoading(false)
      }, 100)
    } catch (e) {
      setError(`Optimizer failed: ${e instanceof Error ? e.message : String(e)}`)
      setIsLoading(false)
    }
  }

  return (
    <main className="optimizer-container">
      <div className="optimizer-wrapper">
        <div className="optimizer-header">
          <h1 className="optimizer-title">Block Optimizer</h1>
          <p className="optimizer-subtitle">Optimize building placement across multiple blocks</p>
        </div>

        {!result && !isLoading && (
          <div className="config-container">
            <div className="config-card">
              <h2 className="config-title">Configuration</h2>

              <div className="config-form">
                <div className="form-group">
                  <label className="form-label">Number of Blocks</label>
                  <input type="number" min="1" max="10" value={numBlocksInput} onChange={(e) => setNumBlocksInput(e.target.value)} className="form-input" />
                  <p className="form-hint">How many blocks to optimize (1-10)</p>
                </div>

                <div className="form-group">
                  <label className="form-label">Size Limit per Block</label>
                  <input type="number" min="1" max="32" value={sizeLimitInput} onChange={(e) => setSizeLimitInput(e.target.value)} className="form-input" />
                  <p className="form-hint">Maximum size units per block (1-32)</p>
                </div>

                <div className="form-group">
                  <label className="form-label">Beam Width</label>
                  <input type="number" min="100" max="2000" step="100" value={beamWidthInput} onChange={(e) => setBeamWidthInput(e.target.value)} className="form-input" />
                  <p className="form-hint">Higher = better solutions but slower (100-2000)</p>
                </div>

                {error && (
                  <div className="error-alert">
                    <p className="error-text">{error}</p>
                  </div>
                )}

                <button onClick={runOptimizer} className="btn-primary">
                  Optimize Blocks
                </button>
              </div>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="loading-container">
            <div className="spinner-wrapper">
              <div className="spinner-base"></div>
              <div className="spinner-animated"></div>
            </div>
            <h2 className="loading-title">Optimizing...</h2>
            <p className="loading-text">
              Computing optimal building placement for {numBlocksInput} block{parseInt(numBlocksInput) !== 1 ? "s" : ""}
            </p>
          </div>
        )}

        {result && !isLoading && (
          <div className="results-container">
            <div className="results-card">
              <div className="results-header">
                <h2 className="results-title">Optimization Results</h2>
                <button onClick={() => setResult(null)} className="btn-secondary">
                  New Optimization
                </button>
              </div>

              <div className="stats-grid">
                <div className="stat-card-green">
                  <div className="stat-label-green">Total Income</div>
                  <div className="stat-value-green">{result.aggregateTotalIncome.toLocaleString()}</div>
                </div>

                <div className="stat-card-blue">
                  <div className="stat-label-blue">Total Storage</div>
                  <div className="stat-value-blue">
                    <div>💰 {result.aggregateTotalStorage.money.toLocaleString()}</div>
                    <div>🪵 {result.aggregateTotalStorage.wood.toLocaleString()}</div>
                    <div>🧱 {result.aggregateTotalStorage.cement.toLocaleString()}</div>
                    <div>⚙️ {result.aggregateTotalStorage.steel.toLocaleString()}</div>
                  </div>
                </div>

                <div className="stat-card-purple">
                  <div className="stat-label-purple">Blocks Optimized</div>
                  <div className="stat-value-purple">{result.blocks.length}</div>
                </div>
              </div>

              <div className="blocks-container">
                {result.blocks.map((block) => (
                  <div key={block.blockNumber} className="block-card">
                    <div className="block-header">
                      <h3 className="block-title">Block {block.blockNumber}</h3>
                      <div className="block-stats">
                        <span className="block-stat">
                          Income: <span className="block-stat-value">{block.totalIncome.toLocaleString()}</span>
                        </span>
                        <span className="block-stat">
                          Size:{" "}
                          <span className="block-stat-value">
                            {block.totalSize}/{sizeLimitInput}
                          </span>
                        </span>
                      </div>
                    </div>

                    <div className="buildings-grid">
                      {block.combination.map((building, idx) => (
                        <div key={idx} className="building-card">
                          <div className="building-header">
                            <div className="building-info">
                              <div className="building-name">{building.name}</div>
                              <div className="building-level">
                                Level {building.level} × {building.count}
                              </div>
                            </div>
                            <div className="building-badge">{building.type}</div>
                          </div>

                          <div className="building-details">
                            <div className="building-detail-row">
                              <span>Income:</span>
                              <span className="building-detail-value">{building.totalIncome.toLocaleString()}</span>
                            </div>
                            <div className="building-detail-row">
                              <span>Size:</span>
                              <span className="building-detail-value">{building.totalSize}</span>
                            </div>
                            {block.averageEfficiencyByType[building.name] && (
                              <div className="building-detail-row">
                                <span>Efficiency:</span>
                                <span className="building-detail-value">{block.averageEfficiencyByType[building.name]}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
