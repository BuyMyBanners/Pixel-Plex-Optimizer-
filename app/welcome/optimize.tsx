// ==================================================
// Block optimizer: maximize income under size limit
// ==================================================

/**
 * Simple logging utility for optimizer debug output.
 * Centralizes debug logging and makes it easy to control verbosity.
 */
class OptimizerLogger {
  constructor(private enabled: boolean) {}

  log(...args: any[]) {
    if (this.enabled) console.log(...args)
  }

  group(label: string) {
    if (this.enabled) console.group(label)
  }

  groupEnd() {
    if (this.enabled) console.groupEnd()
  }

  warn(...args: any[]) {
    if (this.enabled) console.warn(...args)
  }

  error(...args: any[]) {
    if (this.enabled) console.error(...args)
  }
}

/**
 * Optimizer configuration constants.
 */
const OPTIMIZER_CONFIG = {
  /** Beam width for DP state pruning. Higher values = better solutions but slower. */
  DEFAULT_BEAM_WIDTH: 400,
  /** Duplicate building penalty threshold. */
  DUPLICATE_PENALTY_THRESHOLD: 2,
  /** Penalty rate per duplicate building beyond threshold. */
  DUPLICATE_PENALTY_RATE: 0.1,
  /** Bonus per free space unit to break ties between equivalent solutions. */
  SPACE_EFFICIENCY_BONUS: 0.1,
  /** Minimum staffing ratio required for businesses. */
  MIN_STAFFING_RATIO: 0.9,
  /** Penalty for placing storage buildings. */
  STORAGE_PENALTY: 0,
  /** Maximum residents to track in DP state. */
  MAX_RESIDENTS: 1000,
  /** Maximum resource storage to track in DP state. */
  MAX_RESOURCE_UPPER: 100000,
  /** Base resources available before placing buildings. */
  DEFAULT_BASE_RESOURCES: {
    money: 1000,
    wood: 100,
    cement: 100,
    steel: 100,
  },
} as const

/**
 * Building definitions follow the structure in data-file.json.
 * Buildings without a size property default to size = 1.
 * Upgrade income can be specified as incremental (additionalIncome) or absolute (income).
 * Income at level L = baseIncome + sum(additionalIncome for upgrades with level <= L).
 * If upgrade.income is present, it overrides incremental accumulation for that level.
 */

interface BuildingUpgrade {
  level: number
  income?: number
  additionalIncome?: number
  employees?: number
  peopleCapacity?: number
  storageCapacity?: number | ResourceCost
  capacity?: number
  mandatory?: boolean
  cost?: ResourceCost
  prefers?: string[]
}

interface BuildingDefinition {
  baseIncome?: number
  size?: number
  employees?: number
  peopleCapacity?: number
  storageCapacity?: number | ResourceCost
  capacity?: number
  mandatory?: boolean
  baseCost?: ResourceCost
  prefers?: string[]
  upgrades?: BuildingUpgrade[]
}

interface BuildingDefinitions {
  buildingTypes: {
    [typeName: string]: {
      [buildingName: string]: BuildingDefinition
    }
  }
}

type ResourceCost = {
  money?: number
  wood?: number
  cement?: number
  steel?: number
}

type Variant = {
  id: string
  type: string
  name: string
  level: number
  size: number
  income: number
  capacity: number
  storageCapacity?: number | ResourceCost
  mandatory?: boolean
  costs: ResourceCost
  workerType: "employees" | "residents" | null
  prefers?: string[]
}

function isStorageBuilding(v: Variant): boolean {
  return v.storageCapacity !== undefined && typeof v.storageCapacity === "object" && v.workerType === null
}

function buildVariantsFromDefinitions(defs: BuildingDefinitions): Variant[] {
  const variants: Variant[] = []
  if (!defs || !defs.buildingTypes) return variants

  for (const [typeName, typeGroup] of Object.entries(defs.buildingTypes)) {
    for (const [buildingName, buildingDef] of Object.entries(typeGroup as any)) {
      const baseIncome = (buildingDef as any).baseIncome || 0
      const baseSize = (buildingDef as any).size || 1
      const baseWorkers = (buildingDef as any).employees ?? (buildingDef as any).peopleCapacity ?? 0
      const baseStorage = (buildingDef as any).storageCapacity ?? (buildingDef as any).capacity ?? 0
      const basePrefers = (buildingDef as any).prefers || undefined

      const baseCosts: ResourceCost = (buildingDef as any).baseCost || {}

      variants.push({
        id: `${typeName}:${buildingName}:lvl1`,
        type: typeName,
        name: buildingName,
        level: 1,
        size: baseSize,
        income: baseIncome,
        capacity: baseWorkers,
        storageCapacity: baseStorage,
        mandatory: !!(buildingDef as any).mandatory,
        costs: baseCosts,
        workerType: (buildingDef as any).employees ? "employees" : (buildingDef as any).peopleCapacity ? "residents" : null,
        prefers: basePrefers,
      })

      const upgrades = (buildingDef as any).upgrades || []
      const sortedUpgrades = upgrades.slice().sort((a: any, b: any) => a.level - b.level)
      let accumulatedIncome = baseIncome
      let currentWorkers = baseWorkers
      for (const up of sortedUpgrades) {
        const lvl = up.level
        if (typeof up.income === "number") {
          accumulatedIncome = up.income
        } else {
          const add = up.additionalIncome || 0
          accumulatedIncome += add
        }
        if (typeof up.employees === "number") currentWorkers = up.employees
        if (typeof up.peopleCapacity === "number") currentWorkers = up.peopleCapacity
        let currentStorage = baseStorage
        if (typeof up.storageCapacity === "number") currentStorage = up.storageCapacity
        if (typeof up.capacity === "number") currentStorage = up.capacity
        const upPrefers = up.prefers || basePrefers

        const upCosts: ResourceCost = up.cost || {}
        const finalCosts = Object.keys(upCosts).length > 0 ? upCosts : baseCosts

        variants.push({
          id: `${typeName}:${buildingName}:lvl${lvl}`,
          type: typeName,
          name: buildingName,
          level: lvl,
          size: baseSize,
          income: accumulatedIncome,
          capacity: currentWorkers,
          storageCapacity: currentStorage,
          mandatory: !!up.mandatory || !!(buildingDef as any).mandatory,
          costs: finalCosts,
          workerType: up.employees ? "employees" : up.peopleCapacity ? "residents" : (buildingDef as any).employees ? "employees" : (buildingDef as any).peopleCapacity ? "residents" : null,
          prefers: upPrefers,
        })
      }
    }
  }

  return variants
}

/**
 * Solves unbounded knapsack optimization for building placement.
 * Returns combination of variants maximizing total income for given size limit.
 */
export function optimizeBlockIncomeFromDefinitions(defs: BuildingDefinitions, sizeLimit: number, opts?: { debug?: boolean; beamWidth?: number; startingResources?: ResourceCost }) {
  const variants = buildVariantsFromDefinitions(defs)
  const capacity = Math.max(0, Math.floor(sizeLimit))
  const debug = Boolean(opts && opts.debug)
  const logger = new OptimizerLogger(debug)

  const miscNames = Array.from(new Set(variants.filter((v) => v.type === "misc" && v.mandatory).map((v) => v.name)))
  const miscIndex: Record<string, number> = {}
  for (let i = 0; i < miscNames.length; i++) miscIndex[miscNames[i]] = i
  const requiredMask = miscNames.length > 0 ? (1 << miscNames.length) - 1 : 0

  logger.log(`\n=== Optimizer Debug ===`)
  logger.log(`Size limit: ${sizeLimit}`)
  logger.log(`Total variants: ${variants.length}`)
  logger.log(
    `Misc variants found:`,
    variants.filter((v) => v.type === "misc").map((v) => ({ name: v.name, mandatory: v.mandatory, level: v.level }))
  )
  logger.log(`Required misc names:`, miscNames)
  logger.log(`Required mask:`, requiredMask)
  logger.log(`Starting resources:`, opts?.startingResources || "default base resources")

  const businessNames = Array.from(new Set(variants.filter((v) => v.workerType === "employees").map((v) => v.name)))
  const businessIndex: Record<string, number> = {}
  for (let i = 0; i < businessNames.length; i++) businessIndex[businessNames[i]] = i
  const nBusinesses = businessNames.length
  const baseResources = opts?.startingResources || OPTIMIZER_CONFIG.DEFAULT_BASE_RESOURCES

  const houseVariants = variants.filter((v) => v.workerType === "residents")
  const maxPeoplePerSize = houseVariants.reduce((m, v) => Math.max(m, (v.capacity || 0) / Math.max(1, v.size)), 0)
  const maxResidents = Math.min(OPTIMIZER_CONFIG.MAX_RESIDENTS, Math.ceil(capacity * maxPeoplePerSize))

  const storageVariants = variants.filter(isStorageBuilding)
  const maxMoneyStorage = storageVariants.reduce((m, v) => {
    const sc = v.storageCapacity as ResourceCost
    return Math.max(m, (sc.money || 0) / Math.max(1, v.size))
  }, 0)
  const maxWoodStorage = storageVariants.reduce((m, v) => {
    const sc = v.storageCapacity as ResourceCost
    return Math.max(m, (sc.wood || 0) / Math.max(1, v.size))
  }, 0)
  const maxCementStorage = storageVariants.reduce((m, v) => {
    const sc = v.storageCapacity as ResourceCost
    return Math.max(m, (sc.cement || 0) / Math.max(1, v.size))
  }, 0)
  const maxSteelStorage = storageVariants.reduce((m, v) => {
    const sc = v.storageCapacity as ResourceCost
    return Math.max(m, (sc.steel || 0) / Math.max(1, v.size))
  }, 0)

  const maxResourceUpper = {
    money: Math.min(OPTIMIZER_CONFIG.MAX_RESOURCE_UPPER, (baseResources.money || 0) + Math.ceil(capacity * maxMoneyStorage)),
    wood: Math.min(OPTIMIZER_CONFIG.MAX_RESOURCE_UPPER, (baseResources.wood || 0) + Math.ceil(capacity * maxWoodStorage)),
    cement: Math.min(OPTIMIZER_CONFIG.MAX_RESOURCE_UPPER, (baseResources.cement || 0) + Math.ceil(capacity * maxCementStorage)),
    steel: Math.min(OPTIMIZER_CONFIG.MAX_RESOURCE_UPPER, (baseResources.steel || 0) + Math.ceil(capacity * maxSteelStorage)),
  }

  const dpMaps: Array<Map<string, any>> = Array.from({ length: capacity + 1 }, () => new Map())
  const initialCounts = Array(nBusinesses).fill(0)
  const initialBusinessIncomeBase = Array(nBusinesses).fill(0)
  const initialBusinessCapacity = Array(nBusinesses).fill(0)
  const initialCountsStr = initialCounts.join(",")

  const initialPreferenceCapacity = Array(nBusinesses).fill(0)

  const initialNode = {
    prevKey: null,
    prevW: -1,
    variantIndex: -1,
    incomeNeutral: 0,
    houseBaseIncome: 0,
    totalHouseCapacity: 0,
    businessIncomeBaseArr: initialBusinessIncomeBase,
    businessCapacityArr: initialBusinessCapacity,
    countsArr: initialCounts,
    totalStorage: 0,
    total: 0,
    preferenceCapacity: initialPreferenceCapacity,
  }
  dpMaps[0].set(`0:${baseResources.money}:${baseResources.wood}:${baseResources.cement}:${baseResources.steel}:0:${initialCountsStr}`, initialNode)

  const BEAM_WIDTH = opts && typeof opts.beamWidth === "number" ? opts.beamWidth : OPTIMIZER_CONFIG.DEFAULT_BEAM_WIDTH
  const startTimeMs = debug ? Date.now() : 0

  function pruneMapToBeam(m: Map<string, any>, beam: number) {
    if (m.size <= beam) return
    const arr = Array.from(m.entries())
    arr.sort((a, b) => {
      const aTotal = a[1].total || 0
      const bTotal = b[1].total || 0
      const aMask = Number(a[0].split(":")[5]) || 0
      const bMask = Number(b[0].split(":")[5]) || 0
      const aScore = aTotal + (requiredMask !== 0 && aMask === requiredMask ? 1e9 : 0)
      const bScore = bTotal + (requiredMask !== 0 && bMask === requiredMask ? 1e9 : 0)
      return bScore - aScore
    })
    const toKeep = new Set(arr.slice(0, beam).map((e) => e[0]))
    for (const key of m.keys()) {
      if (!toKeep.has(key)) m.delete(key)
    }
  }

  for (let w = 0; w <= capacity; w++) {
    const map = dpMaps[w]
    if (w % 4 === 0) {
      logger.log(`DP progress: processing weight ${w}/${capacity}, states at w=${dpMaps[w].size}`)
    }
    const updatedIndices = new Set<number>()
    for (const [key, node] of map.entries()) {
      const [rStr, moneyStr, woodStr, cementStr, steelStr, maskStr, countsStr] = key.split(":")
      const r = Number(rStr)
      const money = Number(moneyStr)
      const wood = Number(woodStr)
      const cement = Number(cementStr)
      const steel = Number(steelStr)
      const mask = Number(maskStr) || 0
      const countsArr = countsStr ? countsStr.split(",").map((x) => Number(x) || 0) : Array(nBusinesses).fill(0)
      const incomeNeutral = node.incomeNeutral || 0
      const houseBaseIncome = node.houseBaseIncome || 0
      const totalHouseCapacity = node.totalHouseCapacity || 0
      const businessIncomeBaseArr = (node.businessIncomeBaseArr || Array(nBusinesses).fill(0)).slice()
      const businessCapacityArr = (node.businessCapacityArr || Array(nBusinesses).fill(0)).slice()
      const countsArrNode = (node.countsArr || Array(nBusinesses).fill(0)).slice()
      const totalStorageNode = node.totalStorage || 0
      const preferenceCapacityArr = (node.preferenceCapacity || Array(nBusinesses).fill(0)).slice()

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i]
        const nw = w + v.size
        if (nw > capacity) continue

        const isStorageVariant = v.storageCapacity && typeof v.storageCapacity === "object" && v.workerType === null

        if (!isStorageVariant) {
          const costs = v.costs || {}
          const needMoney = costs.money || 0
          const needWood = costs.wood || 0
          const needCement = costs.cement || 0
          const needSteel = costs.steel || 0

          if (money < needMoney || wood < needWood || cement < needCement || steel < needSteel) {
            continue
          }
        }

        if (v.workerType === "employees" && !v.mandatory) {
          const newBusinessCapacity = (businessCapacityArr.reduce((sum: number, cap: number) => sum + cap, 0) || 0) + (v.capacity || 0)
          const currentHouseCapacity = totalHouseCapacity || 0
          const bi = businessIndex[v.name]
          const availableForThisBiz = typeof bi === "number" ? preferenceCapacityArr[bi] || 0 : 0
          const currentlyUsedForThisBiz = typeof bi === "number" ? businessCapacityArr[bi] || 0 : 0
          const wouldHaveStaffing = availableForThisBiz >= currentlyUsedForThisBiz + (v.capacity || 0)

          if (newBusinessCapacity > 0 && (currentHouseCapacity / newBusinessCapacity < OPTIMIZER_CONFIG.MIN_STAFFING_RATIO || !wouldHaveStaffing)) {
            continue
          }
        }

        let newMoney = money
        let newWood = wood
        let newCement = cement
        let newSteel = steel

        if (isStorageVariant && typeof v.storageCapacity === "object") {
          const storageCap = v.storageCapacity as ResourceCost
          newMoney += storageCap.money || 0
          newWood += storageCap.wood || 0
          newCement += storageCap.cement || 0
          newSteel += storageCap.steel || 0
        }

        newMoney = Math.max(0, Math.min(maxResourceUpper.money, newMoney))
        newWood = Math.max(0, Math.min(maxResourceUpper.wood, newWood))
        newCement = Math.max(0, Math.min(maxResourceUpper.cement, newCement))
        newSteel = Math.max(0, Math.min(maxResourceUpper.steel, newSteel))

        let willBeMask = 0
        if (v.type === "misc") {
          const idx = miscIndex[v.name]
          if (typeof idx === "number") willBeMask = 1 << idx
        }

        const countsNext = countsArrNode.slice()
        const businessIncomeBaseNext = businessIncomeBaseArr.slice()
        const businessCapacityNext = businessCapacityArr.slice()
        const preferenceCapacityNext = preferenceCapacityArr.slice()
        let incomeNeutralNext = incomeNeutral
        let houseBaseIncomeNext = houseBaseIncome
        let totalHouseCapacityNext = totalHouseCapacity
        let totalStorageNext = totalStorageNode

        if (v.workerType === "employees") {
          const bi = businessIndex[v.name]
          if (typeof bi === "number") {
            countsNext[bi] = (countsNext[bi] || 0) + 1
            businessIncomeBaseNext[bi] = (businessIncomeBaseNext[bi] || 0) + (v.income || 0)
            businessCapacityNext[bi] = (businessCapacityNext[bi] || 0) + (v.capacity || 0)
          }
        } else if (v.workerType === "residents") {
          houseBaseIncomeNext += v.income || 0
          totalHouseCapacityNext += v.capacity || 0
          const houseCapacity = v.capacity || 0
          if (v.prefers && v.prefers.length > 0) {
            for (const prefBizName of v.prefers) {
              const bi = businessIndex[prefBizName]
              if (typeof bi === "number") {
                preferenceCapacityNext[bi] = (preferenceCapacityNext[bi] || 0) + houseCapacity
              }
            }
          } else {
            for (let bi = 0; bi < nBusinesses; bi++) {
              preferenceCapacityNext[bi] = (preferenceCapacityNext[bi] || 0) + houseCapacity
            }
          }
        } else {
          incomeNeutralNext += v.income || 0
          totalStorageNext = totalStorageNode
        }

        const items: Array<{ incomePerWorker: number; capacity: number; count: number; businessIndex: number }> = []
        for (let bi = 0; bi < nBusinesses; bi++) {
          const totalIncomeBase = businessIncomeBaseNext[bi] || 0
          const totalCap = businessCapacityNext[bi] || 0
          const availableResidents = preferenceCapacityNext[bi] || 0
          const cnt = countsNext[bi] || 0
          const duplicatePenalty = cnt > OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD ? OPTIMIZER_CONFIG.DUPLICATE_PENALTY_RATE * (cnt - OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD) : 0
          const penaltyMultiplier = Math.max(0, 1 - duplicatePenalty)
          const effectiveStaffing = Math.min(totalCap, availableResidents)
          const incomePerWorker = totalCap > 0 ? (totalIncomeBase / totalCap) * penaltyMultiplier : 0
          if (totalCap > 0 && effectiveStaffing > 0) {
            items.push({ incomePerWorker, capacity: effectiveStaffing, count: cnt, businessIndex: bi })
          }
        }
        items.sort((a, b) => b.incomePerWorker - a.incomePerWorker)

        const usedCapacity = Array(nBusinesses).fill(0)
        let businessIncomeEst = 0
        let totalAllocatedEst = 0
        for (const it of items) {
          const bi = it.businessIndex
          const availableForBiz = preferenceCapacityNext[bi] || 0
          const alreadyUsed = usedCapacity[bi] || 0
          const canStillAllocate = Math.min(availableForBiz - alreadyUsed, it.capacity)
          if (canStillAllocate > 0) {
            businessIncomeEst += canStillAllocate * it.incomePerWorker
            usedCapacity[bi] += canStillAllocate
            totalAllocatedEst += canStillAllocate
          }
        }

        let totalUnstaffedCapacity = 0
        let totalBusinessCapacity = 0
        let totalBusinessIncome = 0
        for (let bi = 0; bi < nBusinesses; bi++) {
          const totalCap = businessCapacityNext[bi] || 0
          const totalIncome = businessIncomeBaseNext[bi] || 0
          const staffed = usedCapacity[bi] || 0
          totalUnstaffedCapacity += Math.max(0, totalCap - staffed)
          totalBusinessCapacity += totalCap
          totalBusinessIncome += totalIncome
        }
        const potentialAvgIncomePerWorker = totalBusinessCapacity > 0 ? totalBusinessIncome / totalBusinessCapacity : 15
        const understaffingPenalty = totalUnstaffedCapacity * potentialAvgIncomePerWorker

        const houseEfficiencyEst = totalHouseCapacityNext > 0 ? totalAllocatedEst / totalHouseCapacityNext : 1
        const scaledHouseIncomeEst = houseBaseIncomeNext * houseEfficiencyEst

        const freeSpace = capacity - nw
        const spaceEfficiencyBonus = freeSpace * OPTIMIZER_CONFIG.SPACE_EFFICIENCY_BONUS

        let storagePenalty = 0
        if (isStorageVariant && !v.mandatory) {
          storagePenalty = OPTIMIZER_CONFIG.STORAGE_PENALTY
        }

        const totalEst = Math.round(businessIncomeEst + scaledHouseIncomeEst + incomeNeutralNext - understaffingPenalty + spaceEfficiencyBonus - storagePenalty)

        const maskNew = mask | willBeMask
        const nr = Math.min(maxResidents, Math.max(0, totalHouseCapacityNext - totalAllocatedEst))
        const countsStrNew = countsNext.join(",")
        const newKey = `${nr}:${newMoney}:${newWood}:${newCement}:${newSteel}:${maskNew}:${countsStrNew}`
        const existing = dpMaps[nw].get(newKey)
        if (!existing || totalEst > (existing.total || 0)) {
          dpMaps[nw].set(newKey, {
            prevKey: key,
            prevW: w,
            variantIndex: i,
            incomeNeutral: incomeNeutralNext,
            houseBaseIncome: houseBaseIncomeNext,
            totalHouseCapacity: totalHouseCapacityNext,
            businessIncomeBaseArr: businessIncomeBaseNext,
            businessCapacityArr: businessCapacityNext,
            countsArr: countsNext,
            totalStorage: totalStorageNext,
            total: totalEst,
            preferenceCapacity: preferenceCapacityNext,
          })
          updatedIndices.add(nw)
        }
      }
    }
    for (const idx of updatedIndices) pruneMapToBeam(dpMaps[idx], BEAM_WIDTH)
  }

  const dpStateCounts = dpMaps.map((m) => m.size)
  const durationMs = debug ? Date.now() - startTimeMs : 0

  let bestW = 0
  let bestKey: string | null = null
  let bestValue = Number.NEGATIVE_INFINITY
  let bestWithAllW = -1
  let bestWithAllKey: string | null = null
  let bestWithAllValue = Number.NEGATIVE_INFINITY
  for (let w = 0; w <= capacity; w++) {
    for (const [key, node] of dpMaps[w].entries()) {
      const [, capStr, maskStr] = key.split(":")
      const parts = key.split(":")
      const capAvail = Number(parts[1])
      const maskVal = Number(parts[2]) || 0
      if (capAvail < 0) continue
      if (requiredMask !== 0 && maskVal === requiredMask) {
        const nodeTotal = node.total ?? 0
        if (nodeTotal > bestWithAllValue) {
          bestWithAllValue = nodeTotal
          bestWithAllW = w
          bestWithAllKey = key
        }
      }
      const nodeTotalAll = node.total ?? 0
      if (nodeTotalAll > bestValue) {
        bestValue = nodeTotalAll
        bestW = w
        bestKey = key
      }
    }
  }
  if (requiredMask !== 0) {
    logger.log(`\nChecking for required misc buildings...`)
    logger.log(`Required mask: ${requiredMask}`)
    logger.log(`Best solution with all misc: ${bestWithAllKey ? "FOUND" : "NOT FOUND"}`)
    logger.log(`Best solution with all misc value: ${bestWithAllValue}`)
    logger.log(`Best solution overall: ${bestKey ? "FOUND" : "NOT FOUND"}`)
    logger.log(`Best solution overall value: ${bestValue}`)

    if (!bestWithAllKey) {
      logger.error(`❌ FAILED: No solution found that includes all required misc buildings`)
      logger.log(`This usually means:`)
      logger.log(`  1. Not enough space in the block`)
      logger.log(`  2. Not enough resources to afford misc + other buildings`)
      logger.log(`  3. Misc buildings conflict with other constraints`)
      return null
    }
    bestW = bestWithAllW
    bestKey = bestWithAllKey

    logger.log(`✓ Using solution with all required misc buildings`)
  }

  const counts: Map<string, number> = new Map()
  const chosenSequence: Variant[] = []
  let curW = bestW
  let curKey = bestKey
  while (curW > 0 && curKey) {
    const node = dpMaps[curW].get(curKey)
    if (!node) break
    const idx = node.variantIndex
    if (idx >= 0) {
      const v = variants[idx]
      const keyName = `${v.name}:lvl${v.level}`
      counts.set(keyName, (counts.get(keyName) || 0) + 1)
      chosenSequence.push(v)
    }
    const prevW = node.prevW
    const prevKey = node.prevKey
    curW = prevW
    curKey = prevKey
  }

  const totalCountsByName: Map<string, number> = new Map()
  for (const v of chosenSequence) {
    totalCountsByName.set(v.name, (totalCountsByName.get(v.name) || 0) + 1)
  }

  logger.log(`\nChosen buildings:`)
  const miscInSolution = chosenSequence.filter((v) => v.type === "misc")
  logger.log(`  Misc buildings: ${miscInSolution.length > 0 ? miscInSolution.map((v) => `${v.name} lvl${v.level}`).join(", ") : "NONE"}`)
  logger.log(`  Total buildings: ${chosenSequence.length}`)
  logger.log(`  Total size used: ${chosenSequence.reduce((sum, v) => sum + v.size, 0)}/${capacity}`)

  const combination = Array.from(counts.entries()).map(([key, count]) => {
    const [name, lvlPart] = key.split(":")
    const level = Number(lvlPart.replace("lvl", ""))
    const variant = variants.find((x) => x.name === name && x.level === level)!
    return {
      name,
      level,
      count,
      size: variant.size,
      incomePerBuilding: variant.income,
      capacity: variant.capacity,
      storageCapacity: variant.storageCapacity || 0,
      workerType: variant.workerType,
      totalIncome: variant.income * count,
      totalSize: variant.size * count,
    }
  })
  chosenSequence.reverse()

  function simulateSequence(seq: Variant[]) {
    const residentPools: Map<string, number> = new Map()
    let totalHouseCapacity = 0
    let totalAllocatedEmployees = 0
    let businessIncome = 0
    let houseBaseIncome = 0
    let neutralIncome = 0
    let totalStorageLocal = 0
    const businessCapacityByName: Map<string, number> = new Map()
    const businessAllocatedByName: Map<string, number> = new Map()
    const houseCapacityByName: Map<string, number> = new Map()

    for (const v of seq) {
      if (v.workerType === "residents") {
        const capacity = v.capacity || 0
        totalHouseCapacity += capacity
        houseCapacityByName.set(v.name, (houseCapacityByName.get(v.name) || 0) + capacity)
        houseBaseIncome += v.income

        const prefKey = v.prefers && v.prefers.length > 0 ? v.prefers.slice().sort().join(",") : "*"
        residentPools.set(prefKey, (residentPools.get(prefKey) || 0) + capacity)
      } else if (v.workerType === "employees") {
        const cap = v.capacity || 0
        businessCapacityByName.set(v.name, (businessCapacityByName.get(v.name) || 0) + cap)
      } else {
        neutralIncome += v.income
      }
    }

    for (const v of seq) {
      if (v.workerType === "employees") {
        const cap = v.capacity || 0
        let allocated = 0

        for (const [prefKey, available] of Array.from(residentPools.entries())) {
          if (available <= 0) continue

          const canWork = prefKey === "*" || prefKey.split(",").includes(v.name)
          if (!canWork) continue

          const needed = cap - allocated
          const toAllocate = Math.min(available, needed)
          allocated += toAllocate
          residentPools.set(prefKey, available - toAllocate)

          if (allocated >= cap) break
        }

        businessAllocatedByName.set(v.name, (businessAllocatedByName.get(v.name) || 0) + allocated)
        const efficiency = cap > 0 ? allocated / cap : 1
        const count = seq.filter((x) => x.name === v.name && x.workerType === "employees").length
        const duplicatePenalty = count > OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD ? OPTIMIZER_CONFIG.DUPLICATE_PENALTY_RATE * (count - OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD) : 0
        const penaltyMultiplier = Math.max(0, 1 - duplicatePenalty)
        businessIncome += v.income * efficiency * penaltyMultiplier
        totalAllocatedEmployees += allocated
      }
    }

    const houseEfficiency = totalHouseCapacity > 0 ? totalAllocatedEmployees / totalHouseCapacity : 1
    const scaledHouseIncome = houseBaseIncome * houseEfficiency
    const totalIncomeLocal = Math.round(businessIncome + scaledHouseIncome + neutralIncome)

    return {
      totalIncome: totalIncomeLocal,
      businessIncome,
      scaledHouseIncome,
      neutralIncome,
      totalStorage: totalStorageLocal,
      totalHouseCapacity,
      totalAllocatedEmployees,
      businessCapacityByName,
      businessAllocatedByName,
      houseCapacityByName,
    }
  }

  let currentSeq = chosenSequence.slice()
  let currentMetrics = simulateSequence(currentSeq)

  const finalSeq = currentSeq
  const finalCounts: Map<string, number> = new Map()
  for (const v of finalSeq) {
    const key = `${v.name}:lvl${v.level}`
    finalCounts.set(key, (finalCounts.get(key) || 0) + 1)
  }
  const combinationFinal = Array.from(finalCounts.entries()).map(([key, count]) => {
    const [name, lvlPart] = key.split(":")
    const level = Number(lvlPart.replace("lvl", ""))
    const variant = variants.find((x) => x.name === name && x.level === level)!
    return {
      name,
      level,
      count,
      size: variant.size,
      incomePerBuilding: variant.income,
      capacity: variant.capacity,
      storageCapacity: variant.storageCapacity || 0,
      workerType: variant.workerType,
      type: variant.type,
      totalIncome: variant.income * count,
      totalSize: variant.size * count,
    }
  })

  const finalMetrics = simulateSequence(finalSeq)

  const averageEfficiencyByType: Record<string, string> = {}
  for (const [name, cap] of finalMetrics.businessCapacityByName?.entries() || new Map()) {
    const allocated = finalMetrics.businessAllocatedByName.get(name) || 0
    const count = finalSeq.filter((x) => x.name === name && x.workerType === "employees").length
    const duplicatePenalty = count > OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD ? OPTIMIZER_CONFIG.DUPLICATE_PENALTY_RATE * (count - OPTIMIZER_CONFIG.DUPLICATE_PENALTY_THRESHOLD) : 0
    const baseEff = cap > 0 ? allocated / cap : 1
    const eff = Math.max(0, baseEff - duplicatePenalty)
    averageEfficiencyByType[name] = `${Math.round(eff * 100)}%`
  }
  for (const [name, cap] of finalMetrics.houseCapacityByName?.entries() || new Map()) {
    const eff = finalMetrics.totalHouseCapacity > 0 ? finalMetrics.totalAllocatedEmployees / finalMetrics.totalHouseCapacity : 1
    averageEfficiencyByType[name] = `${Math.round(eff * 100)}%`
  }
  for (const item of combinationFinal) {
    if (!(item.name in averageEfficiencyByType)) {
      if (item.storageCapacity && typeof item.storageCapacity === "object" && item.workerType === null) {
        averageEfficiencyByType[item.name] = `N/A`
      } else {
        averageEfficiencyByType[item.name] = `100%`
      }
    }
  }

  const resultCore = { combination: combinationFinal, totalIncome: finalMetrics.totalIncome, averageEfficiencyByType, totalSize: combinationFinal.reduce((s, c) => s + c.totalSize, 0), totalStorage: finalMetrics.totalStorage }
  if (debug) {
    return { ...resultCore, debugInfo: { dpStateCounts, durationMs } }
  }
  return resultCore
}

/**
 * Optimizes building placement across multiple blocks with shared storage.
 * Income is summed across blocks. Storage is shared globally.
 * Efficiency is calculated per-block. Misc buildings placed once across all blocks.
 *
 * @param defs Building definitions
 * @param numBlocks Number of blocks to optimize
 * @param sizeLimit Size limit per block
 * @param opts Debug and beam width settings
 * @returns Per-block breakdown with aggregate totals, or null if no valid solution
 */
export function optimizeMultipleBlocks(defs: BuildingDefinitions, numBlocks: number, sizeLimit: number, opts?: { debug?: boolean; beamWidth?: number }) {
  if (numBlocks < 1) {
    throw new Error("Number of blocks must be at least 1")
  }

  const variants = buildVariantsFromDefinitions(defs)
  const debug = Boolean(opts && opts.debug)
  const logger = new OptimizerLogger(debug)

  const miscVariants = variants.filter((v) => v.type === "misc" && v.mandatory)
  const miscNames = Array.from(new Set(miscVariants.map((v) => v.name)))

  if (numBlocks === 1) {
    const result = optimizeBlockIncomeFromDefinitions(defs, sizeLimit, opts)
    if (!result) return null

    let blockStorageContribution: ResourceCost = { money: 0, wood: 0, cement: 0, steel: 0 }
    for (const item of result.combination) {
      if (item.storageCapacity && typeof item.storageCapacity === "object") {
        const sc = item.storageCapacity as ResourceCost
        blockStorageContribution.money = (blockStorageContribution.money || 0) + (sc.money || 0) * item.count
        blockStorageContribution.wood = (blockStorageContribution.wood || 0) + (sc.wood || 0) * item.count
        blockStorageContribution.cement = (blockStorageContribution.cement || 0) + (sc.cement || 0) * item.count
        blockStorageContribution.steel = (blockStorageContribution.steel || 0) + (sc.steel || 0) * item.count
      }
    }

    const baseResources: ResourceCost = OPTIMIZER_CONFIG.DEFAULT_BASE_RESOURCES

    const aggregateTotalStorage: ResourceCost = {
      money: (baseResources.money || 0) + (blockStorageContribution.money || 0),
      wood: (baseResources.wood || 0) + (blockStorageContribution.wood || 0),
      cement: (baseResources.cement || 0) + (blockStorageContribution.cement || 0),
      steel: (baseResources.steel || 0) + (blockStorageContribution.steel || 0),
    }

    return {
      blocks: [
        {
          blockNumber: 1,
          combination: result.combination,
          totalIncome: result.totalIncome,
          averageEfficiencyByType: result.averageEfficiencyByType,
          totalSize: result.totalSize,
          blockStorage: blockStorageContribution,
        },
      ],
      aggregateTotalIncome: result.totalIncome,
      aggregateTotalStorage: aggregateTotalStorage,
      baseStorage: baseResources,
      debugInfo: (result as any).debugInfo,
    }
  }

  const blockResults: any[] = []
  let aggregateIncome = 0
  const aggregateStorageFromBuildings: ResourceCost = { money: 0, wood: 0, cement: 0, steel: 0 }

  const baseResources: ResourceCost = OPTIMIZER_CONFIG.DEFAULT_BASE_RESOURCES

  let mandatoryMiscBuildings: any[] = []
  let reservedSize = 0
  let reservedIncome = 0
  let reservedStorage: ResourceCost = { money: 0, wood: 0, cement: 0, steel: 0 }

  if (defs.buildingTypes.misc) {
    for (const buildingName in defs.buildingTypes.misc) {
      const building = defs.buildingTypes.misc[buildingName]
      const isMandatory = building.mandatory || (building.upgrades && building.upgrades.some((up: any) => up.mandatory))

      if (isMandatory) {
        const buildingVariants = buildVariantsFromDefinitions(defs).filter((v) => v.name === buildingName && v.mandatory)

        if (buildingVariants.length > 0) {
          const bestVariant = buildingVariants.reduce((best, curr) => (curr.level > best.level ? curr : best))

          mandatoryMiscBuildings.push(bestVariant)
          reservedSize += bestVariant.size
          reservedIncome += bestVariant.income

          if (bestVariant.storageCapacity && typeof bestVariant.storageCapacity === "object") {
            const sc = bestVariant.storageCapacity as ResourceCost
            reservedStorage.money = (reservedStorage.money || 0) + (sc.money || 0)
            reservedStorage.wood = (reservedStorage.wood || 0) + (sc.wood || 0)
            reservedStorage.cement = (reservedStorage.cement || 0) + (sc.cement || 0)
            reservedStorage.steel = (reservedStorage.steel || 0) + (sc.steel || 0)
          }
        }
      }
    }
  }

  logger.log(`\n\n=== Multi-Block Optimization (${numBlocks} blocks) ===`)
  logger.log(`Size limit per block: ${sizeLimit}`)
  logger.log(`Base resources:`, baseResources)
  logger.log(
    `Mandatory misc buildings reserved:`,
    mandatoryMiscBuildings.map((b) => `${b.name} lvl${b.level} (size: ${b.size})`)
  )
  logger.log(`Total reserved size: ${reservedSize}`)
  logger.log(`Reserved income: ${reservedIncome}`)
  logger.log(`Reserved storage:`, reservedStorage)

  for (let blockIdx = 0; blockIdx < numBlocks; blockIdx++) {
    const blockNum = blockIdx + 1

    const cumulativeStorage: ResourceCost = {
      money: (baseResources.money || 0) + (aggregateStorageFromBuildings.money || 0),
      wood: (baseResources.wood || 0) + (aggregateStorageFromBuildings.wood || 0),
      cement: (baseResources.cement || 0) + (aggregateStorageFromBuildings.cement || 0),
      steel: (baseResources.steel || 0) + (aggregateStorageFromBuildings.steel || 0),
    }

    const isLastBlock = blockIdx === numBlocks - 1
    const effectiveSizeLimit = isLastBlock ? sizeLimit - reservedSize : sizeLimit

    logger.log(`\n--- Block ${blockNum} ---`)
    logger.log(`Cumulative storage available:`, cumulativeStorage)
    logger.log(`Is last block: ${isLastBlock}`)
    if (isLastBlock) {
      logger.log(`Effective size limit (after reservation): ${effectiveSizeLimit}`)
    }

    let blockResult: any

    if (isLastBlock) {
      const modifiedDefs = JSON.parse(JSON.stringify(defs))
      if (modifiedDefs.buildingTypes.misc) {
        for (const buildingName in modifiedDefs.buildingTypes.misc) {
          modifiedDefs.buildingTypes.misc[buildingName].mandatory = false
          if (modifiedDefs.buildingTypes.misc[buildingName].upgrades) {
            modifiedDefs.buildingTypes.misc[buildingName].upgrades.forEach((up: any) => {
              up.mandatory = false
            })
          }
        }
      }

      blockResult = optimizeBlockIncomeFromDefinitions(modifiedDefs, effectiveSizeLimit, {
        ...opts,
        startingResources: cumulativeStorage,
      })
    } else {
      const modifiedDefs = JSON.parse(JSON.stringify(defs))

      for (const typeName in modifiedDefs.buildingTypes) {
        for (const buildingName in modifiedDefs.buildingTypes[typeName]) {
          const building = modifiedDefs.buildingTypes[typeName][buildingName]
          if (typeName === "misc") {
            building.mandatory = false
            if (building.upgrades) {
              building.upgrades.forEach((up: any) => {
                up.mandatory = false
              })
            }
          }
        }
      }

      blockResult = optimizeBlockIncomeFromDefinitions(modifiedDefs, sizeLimit, {
        ...opts,
        startingResources: cumulativeStorage,
      })
    }

    if (!blockResult) {
      logger.error(`Block ${blockNum} optimization failed - no valid solution found`)
      return null
    }

    if (isLastBlock && mandatoryMiscBuildings.length > 0) {
      const mandatoryBuildingItems = mandatoryMiscBuildings.map((variant) => ({
        name: variant.name,
        level: variant.level,
        count: 1,
        size: variant.size,
        incomePerBuilding: variant.income,
        capacity: variant.capacity,
        storageCapacity: variant.storageCapacity || 0,
        workerType: variant.workerType,
        type: variant.type,
        totalIncome: variant.income,
        totalSize: variant.size,
      }))

      blockResult.combination = [...blockResult.combination, ...mandatoryBuildingItems]
      blockResult.totalIncome += reservedIncome
      blockResult.totalSize += reservedSize

      for (const variant of mandatoryMiscBuildings) {
        if (!blockResult.averageEfficiencyByType[variant.name]) {
          blockResult.averageEfficiencyByType[variant.name] = variant.workerType ? "100%" : "N/A"
        }
      }

      logger.log(
        `Injected mandatory misc buildings into last block:`,
        mandatoryMiscBuildings.map((b) => `${b.name} lvl${b.level}`)
      )
    }

    let blockStorageContribution: ResourceCost = { money: 0, wood: 0, cement: 0, steel: 0 }

    for (const item of blockResult.combination) {
      if (item.storageCapacity && typeof item.storageCapacity === "object") {
        const sc = item.storageCapacity as ResourceCost
        blockStorageContribution.money = (blockStorageContribution.money || 0) + (sc.money || 0) * item.count
        blockStorageContribution.wood = (blockStorageContribution.wood || 0) + (sc.wood || 0) * item.count
        blockStorageContribution.cement = (blockStorageContribution.cement || 0) + (sc.cement || 0) * item.count
        blockStorageContribution.steel = (blockStorageContribution.steel || 0) + (sc.steel || 0) * item.count
      }
    }

    blockResults.push({
      blockNumber: blockNum,
      combination: blockResult.combination,
      totalIncome: blockResult.totalIncome,
      averageEfficiencyByType: blockResult.averageEfficiencyByType,
      totalSize: blockResult.totalSize,
      blockStorage: blockStorageContribution,
    })

    logger.log(`Block ${blockNum} placement results:`)
    const miscInBlock = blockResult.combination.filter((item: any) => item.type === "misc")
    if (miscInBlock.length > 0) {
      logger.log(
        `  Misc buildings placed:`,
        miscInBlock.map((b: any) => `${b.name} (${b.count}x)`)
      )
    } else {
      logger.log(`  No misc buildings placed in this block`)
    }

    aggregateIncome += blockResult.totalIncome
    aggregateStorageFromBuildings.money = (aggregateStorageFromBuildings.money || 0) + (blockStorageContribution.money || 0)
    aggregateStorageFromBuildings.wood = (aggregateStorageFromBuildings.wood || 0) + (blockStorageContribution.wood || 0)
    aggregateStorageFromBuildings.cement = (aggregateStorageFromBuildings.cement || 0) + (blockStorageContribution.cement || 0)
    aggregateStorageFromBuildings.steel = (aggregateStorageFromBuildings.steel || 0) + (blockStorageContribution.steel || 0)
  }

  const aggregateTotalStorage: ResourceCost = {
    money: (baseResources.money || 0) + (aggregateStorageFromBuildings.money || 0),
    wood: (baseResources.wood || 0) + (aggregateStorageFromBuildings.wood || 0),
    cement: (baseResources.cement || 0) + (aggregateStorageFromBuildings.cement || 0),
    steel: (baseResources.steel || 0) + (aggregateStorageFromBuildings.steel || 0),
  }

  return {
    blocks: blockResults,
    aggregateTotalIncome: aggregateIncome,
    aggregateTotalStorage: aggregateTotalStorage,
    baseStorage: baseResources,
    debugInfo: debug ? { message: `Multi-block optimization completed for ${numBlocks} blocks` } : undefined,
  }
}

/**
 * Throws error directing caller to use optimizeBlockIncomeFromDefinitions instead.
 */
export function optimizeBlockIncome(sizeLimit: number): never {
  throw new Error("optimizeBlockIncome is not available in this build. Please call optimizeBlockIncomeFromDefinitions(defs, sizeLimit) with the parsed contents of data-file.json.")
}
