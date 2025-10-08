class Block {
  id: string
  buildings: Building[] = []

  constructor(id: string) {
    this.id = id
  }

  addBuilding(building: Building) {
    if (building.size + this.getTotalBuildingSize() > 16) {
      throw new Error("Block is full")
    } else {
      this.buildings.push(building)
    }
  }

  getTotalBuildingSize(): number {
    return this.buildings.reduce((total, building) => total + building.size, 0)
  }

  getBuilding(buildingId: string): Building | null {
    return this.buildings.find((building) => building.buildingId === buildingId) || null
  }
}

class Building {
  name: string
  level: number = 1
  size: number = 1
  buildingId: string = crypto.randomUUID()

  constructor(name: string, level: number = 1, size: number = 1) {
    this.name = name
    this.level = level
    this.size = size
  }
}

class House extends Building {
  residents: Person[] = []

  constructor(name: string, level: number = 1, size: number = 1) {
    super(name, level, size)
  }
}

class Business extends Building {
  employees: Person[] = []
  revenue: number = 0
  requiredSkillLevel: number = Infinity
  maxEmployees: number = 0

  constructor(name: string, revenue: number, level: number = 1) {
    super(name, level)
    this.revenue = revenue
  }

  getBuildingId(): string {
    return this.buildingId
  }
}

class Person {
  id: string
  homeBuilding: House
  workBuilding: Business | null
  skillLevel: number

  constructor(id: string, homeBuilding: House, workBuilding: Business | null, skillLevel: number) {
    this.id = id
    this.homeBuilding = homeBuilding
    this.workBuilding = workBuilding
    this.skillLevel = skillLevel
  }

  canWorkAt(business: Business): boolean {
    return this.skillLevel >= business.requiredSkillLevel && business.employees.length < business.maxEmployees
  }
}

// ==================================================
// Block optimizer: maximize income under size limit
// ==================================================

/**
 * Assumptions
 * - Building definitions follow the structure in `data-file.json` at the repo root.
 * - If a building definition doesn't include a `size` property, we assume size = 1.
 * - `upgrades` entries' `additionalIncome` values are treated as incremental additions to baseIncome
 *   (so income at level L = baseIncome + sum(additionalIncome for upgrades with level <= L)).
 * - Alternatively, an upgrade entry may include an absolute `income` value for that level
 *   (so income at level L = upgrade.income). The optimizer accepts both formats; when
 *   `income` is present it overrides the incremental accumulation for that level.
 * - The optimizer ignores monetary cost and focuses purely on maximizing income per block subject to size.
 */

type BuildingDefinitions = any

type ResourceCost = {
  money?: number
  wood?: number
  cement?: number
  steel?: number
}

type Variant = {
  id: string // unique id like `${type}:${name}:lvl${level}`
  type: string
  name: string
  level: number
  size: number
  income: number
  // capacity: number of people this building can hold or employ (employees for businesses, residents for houses)
  capacity: number
  // storageCapacity: amount of storage this building provides (can be number or multi-resource object)
  storageCapacity?: number | ResourceCost
  // when true on a misc variant, that misc sub-type is required in final solution
  mandatory?: boolean
  // costs: multi-resource costs (money, wood, cement, steel) required to place this building
  costs: ResourceCost
  // 'employees' for businesses, 'residents' for houses, null for neither
  workerType: "employees" | "residents" | null
  // prefers: optional array of business names that residents of this house prefer to work at
  // (only applies to workerType === "residents"). If set, residents only allocate to businesses in this list.
  prefers?: string[]
}

// Helper function to check if a variant is a storage building
function isStorageBuilding(v: Variant): boolean {
  return v.storageCapacity !== undefined && typeof v.storageCapacity === "object" && v.workerType === null
}

/**
 * Create all possible building variants from definitions (each level becomes an item).
 */
function buildVariantsFromDefinitions(defs: BuildingDefinitions): Variant[] {
  const variants: Variant[] = []
  if (!defs || !defs.buildingTypes) return variants

  for (const [typeName, typeGroup] of Object.entries(defs.buildingTypes)) {
    // typeGroup contains named building templates
    for (const [buildingName, buildingDef] of Object.entries(typeGroup as any)) {
      const baseIncome = (buildingDef as any).baseIncome || 0
      const baseSize = (buildingDef as any).size || 1
      // base worker capacity (could be employees for businesses or peopleCapacity for houses)
      const baseWorkers = (buildingDef as any).employees ?? (buildingDef as any).peopleCapacity ?? 0
      // support both `storageCapacity` (new) and `capacity` (storage section JSON)
      const baseStorage = (buildingDef as any).storageCapacity ?? (buildingDef as any).capacity ?? 0
      const basePrefers = (buildingDef as any).prefers || undefined

      // Read base costs (multi-resource)
      const baseCosts: ResourceCost = (buildingDef as any).baseCost || {}

      // base level (level 1)
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
      // Sort upgrades by level to accumulate incremental income correctly
      const sortedUpgrades = upgrades.slice().sort((a: any, b: any) => a.level - b.level)
      let accumulatedIncome = baseIncome
      let currentWorkers = baseWorkers
      for (const up of sortedUpgrades) {
        const lvl = up.level
        // If the upgrade defines an absolute income for this level, use it.
        if (typeof up.income === "number") {
          accumulatedIncome = up.income
        } else {
          // Backwards-compatible: fall back to incremental additionalIncome
          const add = up.additionalIncome || 0
          accumulatedIncome += add
        }
        // upgrades may specify employees or peopleCapacity for the new level (override)
        if (typeof up.employees === "number") currentWorkers = up.employees
        if (typeof up.peopleCapacity === "number") currentWorkers = up.peopleCapacity
        // upgrades may specify storageCapacity or capacity for the new level
        let currentStorage = baseStorage
        if (typeof up.storageCapacity === "number") currentStorage = up.storageCapacity
        if (typeof up.capacity === "number") currentStorage = up.capacity
        const upPrefers = up.prefers || basePrefers

        // Read upgrade costs (multi-resource)
        const upCosts: ResourceCost = up.cost || {}
        // If no upgrade costs specified, inherit from base
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
 * Solve unbounded knapsack where weight = size and value = income.
 * Returns combination of variants (name + level + count) maximizing total income for given sizeLimit.
 */
export function optimizeBlockIncomeFromDefinitions(defs: BuildingDefinitions, sizeLimit: number, opts?: { debug?: boolean; beamWidth?: number }) {
  const variants = buildVariantsFromDefinitions(defs)
  const capacity = Math.max(0, Math.floor(sizeLimit))
  const debug = Boolean(opts && opts.debug)
  // Determine misc sub-types that must each be built (one of each name). Only include misc variants
  // marked `mandatory` in the data file so this requirement is data-driven.
  const miscNames = Array.from(new Set(variants.filter((v) => v.type === "misc" && v.mandatory).map((v) => v.name)))
  const miscIndex: Record<string, number> = {}
  for (let i = 0; i < miscNames.length; i++) miscIndex[miscNames[i]] = i
  const requiredMask = miscNames.length > 0 ? (1 << miscNames.length) - 1 : 0
  // Build a list of business names so we can track counts per business in the DP state
  const businessNames = Array.from(new Set(variants.filter((v) => v.workerType === "employees").map((v) => v.name)))
  const businessIndex: Record<string, number> = {}
  for (let i = 0; i < businessNames.length; i++) businessIndex[businessNames[i]] = i
  const nBusinesses = businessNames.length
  // If there are no misc requirements, proceed as before
  // Resource-aware DP using maps to track (residentsAvailable, resourcesAvailable) per size
  // Base resources available before any buildings
  const baseResources = {
    money: 1000,
    wood: 100,
    cement: 100,
    steel: 100,
  }

  // Determine reasonable bounds for residents and capacity tracking to keep state small
  const houseVariants = variants.filter((v) => v.workerType === "residents")
  const maxPeoplePerSize = houseVariants.reduce((m, v) => Math.max(m, (v.capacity || 0) / Math.max(1, v.size)), 0)
  const maxResidents = Math.min(1000, Math.ceil(capacity * maxPeoplePerSize))

  // Calculate max possible storage per resource based on storage buildings
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
    money: Math.min(100000, baseResources.money + Math.ceil(capacity * maxMoneyStorage)),
    wood: Math.min(100000, baseResources.wood + Math.ceil(capacity * maxWoodStorage)),
    cement: Math.min(100000, baseResources.cement + Math.ceil(capacity * maxCementStorage)),
    steel: Math.min(100000, baseResources.steel + Math.ceil(capacity * maxSteelStorage)),
  }

  // dpMaps[w] = Map keyed by `${r}:${money}:${wood}:${cement}:${steel}:${mask}:${counts}` -> { income, prevKey, prevW, variantIndex }
  // mask is an integer bitmask indicating which misc sub-types have been included
  // counts is a comma-separated list of per-business counts (length = nBusinesses)
  const dpMaps: Array<Map<string, any>> = Array.from({ length: capacity + 1 }, () => new Map())
  const initialCounts = Array(nBusinesses).fill(0)
  const initialBusinessIncomeBase = Array(nBusinesses).fill(0)
  const initialBusinessCapacity = Array(nBusinesses).fill(0)
  const initialCountsStr = initialCounts.join(",")

  // Track which businesses can potentially be staffed based on house preferences
  // For each business, track if we have capacity from houses that prefer it (or have no preference)
  const initialPreferenceCapacity = Array(nBusinesses).fill(0) // capacity available for each business from matching houses

  // aggregated node: compact representation used for DP scoring
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
    preferenceCapacity: initialPreferenceCapacity, // Tracks capacity available for each business based on house preferences
  }
  dpMaps[0].set(`0:${baseResources.money}:${baseResources.wood}:${baseResources.cement}:${baseResources.steel}:0:${initialCountsStr}`, initialNode)

  // Beam width for pruning DP states per weight. Tune this value to trade runtime vs optimality.
  // Lower values are faster but may miss the global optimum. Default is conservative.
  const BEAM_WIDTH = opts && typeof opts.beamWidth === "number" ? opts.beamWidth : 400
  const startTimeMs = debug ? Date.now() : 0

  // Helper: prune a Map to keep only the top `beam` entries by node.total.
  // Always prefer states that already satisfy the required misc mask (so we don't prune valid solutions).
  function pruneMapToBeam(m: Map<string, any>, beam: number) {
    if (m.size <= beam) return
    const arr = Array.from(m.entries())
    // compute score and sort
    arr.sort((a, b) => {
      const aTotal = a[1].total || 0
      const bTotal = b[1].total || 0
      // parse mask from key 'nr:money:wood:cement:steel:mask:counts'
      const aMask = Number(a[0].split(":")[5]) || 0
      const bMask = Number(b[0].split(":")[5]) || 0
      const aScore = aTotal + (requiredMask !== 0 && aMask === requiredMask ? 1e9 : 0)
      const bScore = bTotal + (requiredMask !== 0 && bMask === requiredMask ? 1e9 : 0)
      return bScore - aScore
    })
    // keep top beam keys
    const toKeep = new Set(arr.slice(0, beam).map((e) => e[0]))
    for (const key of m.keys()) {
      if (!toKeep.has(key)) m.delete(key)
    }
  }

  // helper to reconstruct sequence (in addition order) from a DP state key
  function reconstructSequence(wIdx: number, keyStr: string) {
    const seq: Variant[] = []
    let curW = wIdx
    let curKey = keyStr
    while (curW > 0 && curKey) {
      const node = dpMaps[curW].get(curKey)
      if (!node) break
      const idx = node.variantIndex
      if (typeof idx === "number" && idx >= 0) seq.push(variants[idx])
      const prevW = node.prevW
      const prevKey = node.prevKey
      curW = prevW
      curKey = prevKey
    }
    return seq.reverse()
  }

  // lightweight local simulation used inside DP transitions to estimate final total income
  function computeTotalForSequence(seq: Variant[]) {
    let availableResidents = 0
    let totalHouseCapacity = 0
    let totalAllocatedEmployees = 0
    let businessIncome = 0
    let houseBaseIncome = 0
    let neutralIncome = 0
    const businessCapacityByName: Map<string, number> = new Map()
    const businessAllocatedByName: Map<string, number> = new Map()

    for (const v of seq) {
      if (v.workerType === "residents") {
        availableResidents += v.capacity || 0
        totalHouseCapacity += v.capacity || 0
        businessCapacityByName.set(v.name, businessCapacityByName.get(v.name) || 0)
        houseBaseIncome += v.income
      } else if (v.workerType === "employees") {
        const cap = v.capacity || 0
        const allocated = Math.min(availableResidents, cap)
        businessAllocatedByName.set(v.name, (businessAllocatedByName.get(v.name) || 0) + allocated)
        businessCapacityByName.set(v.name, (businessCapacityByName.get(v.name) || 0) + cap)
        availableResidents -= allocated
        totalAllocatedEmployees += allocated
      } else {
        neutralIncome += v.income
      }
    }

    // compute business income applying duplicate penalty per type
    for (const [name, cap] of businessCapacityByName.entries()) {
      const allocated = businessAllocatedByName.get(name) || 0
      const variantCount = seq.filter((x) => x.name === name && x.workerType === "employees").length
      const duplicatePenalty = variantCount > 2 ? 0.1 * (variantCount - 2) : 0
      const penaltyMultiplier = Math.max(0, 1 - duplicatePenalty)
      businessIncome += (cap > 0 ? (allocated / cap) * cap : 0) * penaltyMultiplier
      // the above multiplies back to allocated * average per-worker income roughly
    }

    const houseEfficiency = totalHouseCapacity > 0 ? totalAllocatedEmployees / totalHouseCapacity : 1
    const scaledHouseIncome = houseBaseIncome * houseEfficiency
    const totalIncomeLocal = Math.round(businessIncome + scaledHouseIncome + neutralIncome)
    return totalIncomeLocal
  }

  for (let w = 0; w <= capacity; w++) {
    const map = dpMaps[w]
    if (debug) {
      // optional quick progress log per weight
      // (keep logs concise to avoid overwhelming the console)
      // We'll provide a full per-weight snapshot at the end as well.
      // Log every 4 weights to reduce noise for larger capacities.
      if (w % 4 === 0) console.log(`DP progress: processing weight ${w}/${capacity}, states at w=${dpMaps[w].size}`)
    }
    // track which dpMaps indices were updated during this iteration so we can prune them
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
      // aggregated node fields
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

        // Check if this is a storage building (storage is free to build)
        const isStorageVariant = v.storageCapacity && typeof v.storageCapacity === "object" && v.workerType === null

        // Check if we have enough of each resource to afford this building (skip for storage)
        if (!isStorageVariant) {
          const costs = v.costs || {}
          const needMoney = costs.money || 0
          const needWood = costs.wood || 0
          const needCement = costs.cement || 0
          const needSteel = costs.steel || 0

          if (money < needMoney || wood < needWood || cement < needCement || steel < needSteel) {
            continue // Can't afford this building
          }
        }

        // Avoid adding business capacity that would create significant understaffing.
        // Calculate the staffing ratio after adding this business. Require a high match between
        // available resident capacity (respecting preferences) and business capacity.
        if (v.workerType === "employees") {
          const newBusinessCapacity = (businessCapacityArr.reduce((sum: number, cap: number) => sum + cap, 0) || 0) + (v.capacity || 0)
          const currentHouseCapacity = totalHouseCapacity || 0
          // Also check if this specific business can be staffed given house preferences
          const bi = businessIndex[v.name]
          const availableForThisBiz = typeof bi === "number" ? preferenceCapacityArr[bi] || 0 : 0
          const currentlyUsedForThisBiz = typeof bi === "number" ? businessCapacityArr[bi] || 0 : 0
          const wouldHaveStaffing = availableForThisBiz >= currentlyUsedForThisBiz + (v.capacity || 0)

          // Require at least 90% potential staffing ratio AND this specific business must be staffable
          // Allow small margin (90%) to permit some flexibility, but strongly enforce near 1:1
          if (newBusinessCapacity > 0 && (currentHouseCapacity / newBusinessCapacity < 0.9 || !wouldHaveStaffing)) {
            continue // Skip this business - would create understaffing or no matching residents
          }
        }

        // Compute new resource levels after placing this building
        // Storage represents available capacity and only increases (never consumed by regular buildings)
        let newMoney = money
        let newWood = wood
        let newCement = cement
        let newSteel = steel

        // Storage buildings add storage capacity (increase available resources)
        if (isStorageVariant && typeof v.storageCapacity === "object") {
          const storageCap = v.storageCapacity as ResourceCost
          newMoney += storageCap.money || 0
          newWood += storageCap.wood || 0
          newCement += storageCap.cement || 0
          newSteel += storageCap.steel || 0
        }
        // Regular buildings do not consume storage; storage capacity only increases when storage buildings are added.

        // Clamp resources to valid range [0, maxResourceUpper]
        newMoney = Math.max(0, Math.min(maxResourceUpper.money, newMoney))
        newWood = Math.max(0, Math.min(maxResourceUpper.wood, newWood))
        newCement = Math.max(0, Math.min(maxResourceUpper.cement, newCement))
        newSteel = Math.max(0, Math.min(maxResourceUpper.steel, newSteel)) // compute mask bit for this variant if it's a misc sub-type
        let willBeMask = 0
        if (v.type === "misc") {
          const idx = miscIndex[v.name]
          if (typeof idx === "number") willBeMask = 1 << idx
        }

        // prepare next aggregated arrays
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
          // Update preference capacity: add this house's capacity to all businesses it prefers
          const houseCapacity = v.capacity || 0
          if (v.prefers && v.prefers.length > 0) {
            // House has specific preferences
            for (const prefBizName of v.prefers) {
              const bi = businessIndex[prefBizName]
              if (typeof bi === "number") {
                preferenceCapacityNext[bi] = (preferenceCapacityNext[bi] || 0) + houseCapacity
              }
            }
          } else {
            // No preferences means can work anywhere
            for (let bi = 0; bi < nBusinesses; bi++) {
              preferenceCapacityNext[bi] = (preferenceCapacityNext[bi] || 0) + houseCapacity
            }
          }
        } else {
          incomeNeutralNext += v.income || 0
          // totalStorageNext is deprecated with multi-resource storage (tracked in DP state key)
          totalStorageNext = totalStorageNode
        }

        // estimate final total using greedy allocation based on aggregated arrays
        // Preference-aware: use `preferenceCapacity` rather than total house capacity when estimating staffing.
        // build items list with preference-constrained staffing potential
        const items: Array<{ incomePerWorker: number; capacity: number; count: number; businessIndex: number }> = []
        for (let bi = 0; bi < nBusinesses; bi++) {
          const totalIncomeBase = businessIncomeBaseNext[bi] || 0
          const totalCap = businessCapacityNext[bi] || 0
          const availableResidents = preferenceCapacityNext[bi] || 0 // Use preference-aware resident capacity
          const cnt = countsNext[bi] || 0
          const duplicatePenalty = cnt > 2 ? 0.1 * (cnt - 2) : 0
          const penaltyMultiplier = Math.max(0, 1 - duplicatePenalty)
          // Only consider businesses that can actually be staffed (have matching house preferences)
          const effectiveStaffing = Math.min(totalCap, availableResidents)
          const incomePerWorker = totalCap > 0 ? (totalIncomeBase / totalCap) * penaltyMultiplier : 0
          if (totalCap > 0 && effectiveStaffing > 0) {
            items.push({ incomePerWorker, capacity: effectiveStaffing, count: cnt, businessIndex: bi })
          }
        }
        items.sort((a, b) => b.incomePerWorker - a.incomePerWorker)

        // Allocate residents greedily by best income per worker, respecting preference constraints
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

        // Apply a penalty for unstaffed business capacity to discourage over-provisioning.
        // Calculate total unstaffed capacity and adjust estimated income to reflect opportunity cost.
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
        // Penalty: use the POTENTIAL average income per worker (what they COULD earn if fully staffed)
        // rather than actual allocated income. This better represents opportunity cost.
        const potentialAvgIncomePerWorker = totalBusinessCapacity > 0 ? totalBusinessIncome / totalBusinessCapacity : 15
        // Apply penalty at 100% of potential income per worker - each empty slot is fully penalized
        // This strongly discourages building businesses without sufficient housing
        const understaffingPenalty = totalUnstaffedCapacity * potentialAvgIncomePerWorker

        const houseEfficiencyEst = totalHouseCapacityNext > 0 ? totalAllocatedEst / totalHouseCapacityNext : 1
        const scaledHouseIncomeEst = houseBaseIncomeNext * houseEfficiencyEst

        // Add a small space-efficiency bonus to slightly favor solutions that leave more free space.
        // This helps break ties between otherwise equivalent-income solutions.
        // Bonus: 0.1 per free space unit (insufficient to override income differences).
        const freeSpace = capacity - nw
        const spaceEfficiencyBonus = freeSpace * 0.1

        const totalEst = Math.round(businessIncomeEst + scaledHouseIncomeEst + incomeNeutralNext - understaffingPenalty + spaceEfficiencyBonus)

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
    // prune any dpMaps entries that were updated in this iteration to limit state growth
    for (const idx of updatedIndices) pruneMapToBeam(dpMaps[idx], BEAM_WIDTH)
  }

  // collect per-weight dp state counts for debug output
  const dpStateCounts = dpMaps.map((m) => m.size)
  const durationMs = debug ? Date.now() - startTimeMs : 0

  // Find best ending state across all sizes and states where final available capacity is non-negative
  // Prefer states that include all required misc sub-types (mask === requiredMask). If none exist, return null (no valid solution).
  let bestW = 0
  let bestKey: string | null = null
  let bestValue = Number.NEGATIVE_INFINITY
  let bestWithAllW = -1
  let bestWithAllKey: string | null = null
  let bestWithAllValue = Number.NEGATIVE_INFINITY
  for (let w = 0; w <= capacity; w++) {
    for (const [key, node] of dpMaps[w].entries()) {
      const [, capStr, maskStr] = key.split(":")
      // counts part may follow; split into 4 parts to be safe
      const parts = key.split(":")
      const capAvail = Number(parts[1])
      const maskVal = Number(parts[2]) || 0
      if (capAvail < 0) continue // final state must have non-negative capacity
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
  // If there are misc requirements, require a state that includes all misc sub-types
  if (requiredMask !== 0) {
    if (!bestWithAllKey) {
      // no feasible solution includes all required misc sub-types
      return null
    }
    bestW = bestWithAllW
    bestKey = bestWithAllKey
  }

  // Reconstruct chosen variants by backtracking parent pointers
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

  // Compute total counts per building name (used for duplicate-business penalty)
  const totalCountsByName: Map<string, number> = new Map()
  for (const v of chosenSequence) {
    totalCountsByName.set(v.name, (totalCountsByName.get(v.name) || 0) + 1)
  }

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
  // Now simulate staffing forward in the original addition order to compute exact employee allocations
  // Reverse chosenSequence to get the order items were added
  chosenSequence.reverse()

  // Helper: simulate a chosen sequence (ordered array of Variants) and compute metrics
  function simulateSequence(seq: Variant[]) {
    // Track resident pools: map from preference-set key to available count
    // Key format: "BusinessA,BusinessB" (sorted) or "*" for no preference
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

    // First pass: collect residents from houses and build business capacity map
    for (const v of seq) {
      if (v.workerType === "residents") {
        const capacity = v.capacity || 0
        totalHouseCapacity += capacity
        houseCapacityByName.set(v.name, (houseCapacityByName.get(v.name) || 0) + capacity)
        // totalStorageLocal is deprecated with multi-resource storage
        houseBaseIncome += v.income

        // Determine preference key for this house's residents
        const prefKey = v.prefers && v.prefers.length > 0 ? v.prefers.slice().sort().join(",") : "*"
        residentPools.set(prefKey, (residentPools.get(prefKey) || 0) + capacity)
      } else if (v.workerType === "employees") {
        const cap = v.capacity || 0
        businessCapacityByName.set(v.name, (businessCapacityByName.get(v.name) || 0) + cap)
      } else {
        neutralIncome += v.income
        // totalStorageLocal is deprecated with multi-resource storage
      }
    }

    // Second pass: allocate residents to businesses respecting preferences
    for (const v of seq) {
      if (v.workerType === "employees") {
        const cap = v.capacity || 0
        let allocated = 0

        // Try to fill from preference-specific pools first
        for (const [prefKey, available] of Array.from(residentPools.entries())) {
          if (available <= 0) continue

          // Check if this business matches the preference
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
        // duplicate penalty uses total counts in seq
        const count = seq.filter((x) => x.name === v.name && x.workerType === "employees").length
        const duplicatePenalty = count > 2 ? 0.1 * (count - 2) : 0
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

  // Greedy consolidation: disabled for multi-resource storage because of complexity.
  // The DP optimizer is responsible for selecting storage optimally.
  let currentSeq = chosenSequence.slice()
  let currentMetrics = simulateSequence(currentSeq)

  // After consolidation (disabled), set `chosenSequence` to `currentSeq` and recompute counts.
  const finalSeq = currentSeq
  const finalCounts: Map<string, number> = new Map()
  for (const v of finalSeq) {
    const key = `${v.name}:lvl${v.level}`
    finalCounts.set(key, (finalCounts.get(key) || 0) + 1)
  }
  // rebuild combination from finalCounts
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
      totalIncome: variant.income * count,
      totalSize: variant.size * count,
    }
  })

  // Use finalSeq for the rest of the reporting
  // compute final metrics for return
  const finalMetrics = simulateSequence(finalSeq)

  // Compute per-building-type average efficiencies (rounded to nearest percent) using final metrics
  const averageEfficiencyByType: Record<string, string> = {}
  // Include business efficiencies
  for (const [name, cap] of finalMetrics.businessCapacityByName?.entries() || new Map()) {
    const allocated = finalMetrics.businessAllocatedByName.get(name) || 0
    const count = finalSeq.filter((x) => x.name === name && x.workerType === "employees").length
    const duplicatePenalty = count > 2 ? 0.1 * (count - 2) : 0
    const baseEff = cap > 0 ? allocated / cap : 1
    const eff = Math.max(0, baseEff - duplicatePenalty)
    averageEfficiencyByType[name] = `${Math.round(eff * 100)}%`
  }
  // Include house efficiencies
  for (const [name, cap] of finalMetrics.houseCapacityByName?.entries() || new Map()) {
    const eff = finalMetrics.totalHouseCapacity > 0 ? finalMetrics.totalAllocatedEmployees / finalMetrics.totalHouseCapacity : 1
    averageEfficiencyByType[name] = `${Math.round(eff * 100)}%`
  }
  // Include any neutral building names (mark as 100% or N/A for storage-only)
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
 * Convenience helper that tries to read `data-file.json` (Node environment) and optimize for the given size.
 * If file reading is not available (e.g., running in browser), throws an informative error and suggests
 * calling `optimizeBlockIncomeFromDefinitions` with parsed data instead.
 */
export function optimizeBlockIncome(sizeLimit: number): never {
  throw new Error("optimizeBlockIncome is not available in this build. Please call optimizeBlockIncomeFromDefinitions(defs, sizeLimit) with the parsed contents of data-file.json.")
}
