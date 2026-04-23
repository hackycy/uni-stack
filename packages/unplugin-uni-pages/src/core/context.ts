import type { FSWatcher } from 'chokidar'
import type { PagesConfig, SubPackage } from '..'
import type { Options, ResolvedOptions, ScanPageRouteBlock } from '../types'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  atomicWriteFile,
  compareStringWithFile,
  findConfigFile,
  jsoncAssign,
  jsoncParse,
  jsoncStringify,
  parse,
} from '@uni-aide/core'
import chokidar from 'chokidar'
import lockfile from 'proper-lockfile'
import { globSync } from 'tinyglobby'
import { DEFAULT_SEQ, FILE_EXTENSIONS, PAGES_CONFIG_FILE } from './constants'
import { resolveOptions } from './options'
import {
  extsToGlob,
  forbiddenOverwritePagePath,
  getRouteSfcBlock,
  parseCustomBlock,
  parseSFC,
  slash,
} from './utils'

export class Context {
  options: ResolvedOptions
  root: string = process.cwd()

  // scan pages
  scanPagesMap: Map<string, ScanPageRouteBlock> = new Map()
  scanSubPackagesMap: Map<string, ScanPageRouteBlock> = new Map()
  scanTabBarMap: Map<string, ScanPageRouteBlock> = new Map()

  private watcher: FSWatcher | null = null
  private watchTargets: string[] = []

  constructor(private rawOptions: Options) {
    this.options = resolveOptions(this.rawOptions, this.root)
  }

  setRoot(root: string) {
    if (this.root === root) {
      return
    }

    this.root = root
    this.options = resolveOptions(this.rawOptions, this.root)

    if (this.watcher) {
      this.setupWatcher()
    }
  }

  setupWatcher() {
    const sourceConfigPath = findConfigFile(
      this.options.configSource,
      PAGES_CONFIG_FILE,
    )
    if (!sourceConfigPath) {
      this.stopWatcher()
      return
    }

    const normalizedConfigPath = slash(sourceConfigPath)
    const watchTargets = this.createWatchTargets(normalizedConfigPath)
    if (watchTargets.length === 0) {
      this.stopWatcher()
      return
    }

    if (this.watcher && this.hasSameWatchTargets(watchTargets)) {
      return
    }

    this.stopWatcher()

    this.watcher = chokidar.watch(watchTargets, {
      ignoreInitial: true, // Don't fire events for initial add
      ignored: this.options.exclude,
    })
    this.watchTargets = watchTargets

    const handleFileChange = async (filePath?: string) => {
      if (filePath && !this.shouldHandleFile(filePath, normalizedConfigPath)) {
        return
      }
      await this.writePagesJSON()
    }

    this.watcher.on('add', handleFileChange)
    this.watcher.on('change', handleFileChange)
    this.watcher.on('unlink', handleFileChange)
  }

  async close() {
    await this.stopWatcher()
  }

  private createWatchTargets(sourceConfigPath: string): string[] {
    const targets = new Set<string>()
    targets.add(sourceConfigPath)

    if (this.options.scanDir && this.options.scanDir.length > 0) {
      this.options.scanDir.forEach((dir) => {
        targets.add(slash(dir))
      })
    }

    return Array.from(targets).sort()
  }

  private hasSameWatchTargets(nextTargets: string[]): boolean {
    if (this.watchTargets.length !== nextTargets.length) {
      return false
    }

    return this.watchTargets.every(
      (target, index) => target === nextTargets[index],
    )
  }

  private async stopWatcher() {
    if (!this.watcher) {
      this.watchTargets = []
      return
    }

    const currentWatcher = this.watcher
    this.watcher = null
    this.watchTargets = []

    try {
      await currentWatcher.close()
    }
    catch (error) {
      console.error('[unplugin-uni-pages] failed to close watcher.')
      console.error(error instanceof Error ? error.message : `${error}`)
    }
  }

  private shouldHandleFile(filePath: string, configPath: string): boolean {
    const normalizedPath = slash(filePath)
    if (normalizedPath === configPath) {
      return true
    }

    const ext = path.extname(normalizedPath).slice(1).toLowerCase()
    return Boolean(ext) && FILE_EXTENSIONS.includes(ext)
  }

  async writePagesJSON() {
    // 使用 lockfile 防止并发写入
    let release: (() => Promise<void>) | null = null

    try {
      release = await lockfile.lock(this.options.outputJsonPath, {
        retries: 0,
        stale: 5000,
      })
    }
    catch {
      // 获取锁失败，则视为被占用，直接返回
      return
    }

    try {
      const jsonc = await parse(PAGES_CONFIG_FILE, {
        cwd: this.options.configSource,
      })

      // 扫描页面
      await this.scan()

      // 合并扫描结果
      const pageMeta = jsoncParse(jsonc) as PagesConfig
      if (!pageMeta.pages) {
        pageMeta.pages = []
      }

      // 记录最原始的页面路径排序
      const originalPathSeqMap = new Map<string, number>()
      pageMeta.pages.forEach((page, index) => {
        originalPathSeqMap.set(page.path, index)
      })
      pageMeta.subPackages?.forEach((subPackage) => {
        subPackage.pages?.forEach((subPage, index) => {
          const fullPath = `${subPackage.root}/${subPage.path}`
          originalPathSeqMap.set(fullPath, index)
        })
      })
      // tabbar list 排序优先需要覆盖pages上的排序
      pageMeta.tabBar?.list?.forEach((tabBarItem, index) => {
        originalPathSeqMap.set(tabBarItem.pagePath, index)
      })

      if (this.scanPagesMap.size > 0) {
        const mergedPages = new Set<string>()
        // 合并同样路径的页面配置，配置文件优先级高会覆盖扫描到的配置
        pageMeta.pages.forEach((page) => {
          const route = this.scanPagesMap.get(page.path)
          if (route) {
            jsoncAssign(page, route.content)
            mergedPages.add(page.path)
          }
        })

        // 添加剩余未处理的扫描页面
        for (const [routePath, route] of this.scanPagesMap) {
          if (mergedPages.has(routePath)) {
            continue
          }

          pageMeta.pages.push(
            jsoncAssign(
              forbiddenOverwritePagePath({}, 'path', routePath),
              route.content,
            ) as any,
          )
          mergedPages.add(routePath)
        }
      }

      if (this.scanTabBarMap.size > 0) {
        // prevent tabBar or tabBar.list is undefined
        if (!pageMeta.tabBar) {
          pageMeta.tabBar = {}
        }
        if (!pageMeta.tabBar.list) {
          pageMeta.tabBar.list = []
        }

        const mergedTabBarPages = new Set<string>()
        // 合并同样路径的 tabBar 配置，配置文件优先级高会覆盖扫描到的配置
        pageMeta.tabBar.list!.forEach((tabBarItem) => {
          const route = this.scanTabBarMap.get(tabBarItem.pagePath)
          if (route) {
            jsoncAssign(
              forbiddenOverwritePagePath(
                tabBarItem,
                'pagePath',
                tabBarItem.pagePath,
              ),
              route.content,
            )
            mergedTabBarPages.add(tabBarItem.pagePath)
          }
        })

        for (const [routePath, route] of this.scanTabBarMap) {
          if (mergedTabBarPages.has(routePath)) {
            continue
          }

          pageMeta.tabBar.list!.push(
            jsoncAssign(
              forbiddenOverwritePagePath({}, 'pagePath', routePath),
              route.content,
            ) as any,
          )
          mergedTabBarPages.add(routePath)
        }

        // 处理排序 先根据路径字符串排序，再根据 seq 排序
        pageMeta.tabBar
          .list!.sort((a, b) => {
          const pageA = a.pagePath
          const pageB = b.pagePath
          return pageA.localeCompare(pageB)
        }).sort((a, b) => {
          const routeA = this.scanTabBarMap.get(a.pagePath)
          const routeB = this.scanTabBarMap.get(b.pagePath)
          const seqA
            = routeA?.seq ?? originalPathSeqMap.get(a.pagePath) ?? DEFAULT_SEQ
          const seqB
            = routeB?.seq ?? originalPathSeqMap.get(b.pagePath) ?? DEFAULT_SEQ
          return seqA - seqB
        })
      }

      // 处理分包页面扫描
      if (this.scanSubPackagesMap.size > 0) {
        // prevent subPackages is undefined
        if (!pageMeta.subPackages) {
          pageMeta.subPackages = []
        }

        // 所有分包页面路径
        const allSubPackagesPath = new Set<string>()
        // 配置文件中已分配的分包路径，该路径优先，避免自动分配冲突
        const defineSubPackageRoots = new Set<string>()
        pageMeta.subPackages.forEach((subPackage) => {
          if (subPackage.root) {
            defineSubPackageRoots.add(subPackage.root)

            // 记录已存在的分包页面路径
            if (subPackage.pages && subPackage.pages.length > 0) {
              subPackage.pages.forEach((subPage) => {
                allSubPackagesPath.add(`${subPackage.root}/${subPage.path}`)
              })
            }
          }
        })
        for (const routePath of this.scanSubPackagesMap.keys()) {
          allSubPackagesPath.add(routePath)
        }

        // 排序路径数组：以便按顺序比较路径。
        // LCP函数：计算两个路径字符串的最长共同目录前缀（始终以 '/' 结尾）。
        // 分组路径：迭代排序后的路径，根据LCP将路径分组到不同的根下。
        // 处理每组：对于每个组，根路径是LCP去掉尾部斜杠，页面是路径去掉LCP后的部分。
        // 处理边界情况：如路径无斜杠或空数组。

        // ['pages/subpackage/comment', 'pages/subpackage/list/list', 'pages/subpackage/goods', 'pages/sub2/list']
        // 转换为
        // {
        //   'pages/sub2': ['list'],
        //   'pages/subpackage': ['comment', 'goods', 'list/list']
        // }
        const sortedPaths = Array.from(allSubPackagesPath).sort()

        // LCP函数：返回两个字符串的最长共同目录前缀（以'/'结尾）
        function lcpPath(str1: string, str2: string) {
          let i = 0
          while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
            i++
          }
          const common = str1.substring(0, i)
          const lastSlash = common.lastIndexOf('/')
          if (lastSlash === -1) {
            return '' // 无共同目录
          }
          else {
            return common.substring(0, lastSlash + 1) // 返回至最后一个斜杠（包含）
          }
        }

        const parsedSubPackagesMap = new Map<string, string[]>()

        const dirPrefix = (p: string) =>
          p.includes('/') ? p.substring(0, p.lastIndexOf('/') + 1) : ''

        const shouldSplitByLCP = (nextLCP: string, currentLCP: string) => {
          // nextLCP 为空：说明没有共同目录，需要拆组
          if (!nextLCP) {
            return true
          }

          // currentLCP 被更短的已定义分包根包含, 继续归为一组
          if (Array.from(defineSubPackageRoots).some(root => currentLCP.startsWith(`${root}/`) && currentLCP !== root)) {
            return false
          }

          // 如果 LCP 变成了只有一级的目录（如 'pages/'）
          // 只要这个一级目录下未存在文件，那么则视为非最短的分包根，继续归为一组
          // 即 pages/ 下还有其他文件，则说明 pages/ 是一个有效的分包根，需拆组
          // 如果 pages/ 下没有其他文件，则说明 pages/ 不是一个有效的分包根，继续归为一组
          // 例如 pages/a 和 pages/b/a 的 LCP 是 pages/ （a为文件）
          const isTopLevel = nextLCP.split('/').length === 2
          if (isTopLevel) {
            const potentialRoot = nextLCP.slice(0, -1) // 去掉末尾斜杠
            const hasFiles = Array.from(allSubPackagesPath).some(
              p => p !== potentialRoot && p.startsWith(`${potentialRoot}/`) && p.split('/').length <= 2,
            )
            // 当前目录下没有文件，则不该使用该目录作为分包根
            if (!hasFiles) {
              return true
            }
          }

          return false
        }

        const finalizeGroup = (group: string[], groupLCP: string) => {
          let lcp = groupLCP
          if (!lcp) {
            lcp = dirPrefix(group[0])
          }

          const root = lcp.endsWith('/') ? lcp.slice(0, -1) : lcp
          if (!root) {
            return
          }

          if (!parsedSubPackagesMap.has(root)) {
            parsedSubPackagesMap.set(root, [])
          }

          for (const p of group) {
            const page = p.substring(lcp.length)
            parsedSubPackagesMap.get(root)!.push(page)
          }
        }

        let currentGroup: string[] = [sortedPaths[0]]
        // 当前组的 LCP（以 '/' 结尾）。
        let currentLCP: string = dirPrefix(sortedPaths[0])

        for (let i = 1; i < sortedPaths.length; i++) {
          const fullPath = sortedPaths[i]
          const nextLCP = lcpPath(currentLCP, fullPath)

          if (shouldSplitByLCP(nextLCP, currentLCP)) {
            finalizeGroup(currentGroup, currentLCP)
            currentGroup = [fullPath]
            currentLCP = dirPrefix(fullPath)
            continue
          }

          // 同组：允许 currentLCP 变短（例如：pages/onecard/order/list + pages/onecard/search => pages/onecard/）
          currentGroup.push(fullPath)
          currentLCP = nextLCP
        }

        finalizeGroup(currentGroup, currentLCP)

        // 最终合并配置
        for (const [root, paths] of parsedSubPackagesMap.entries()) {
          for (const path of paths) {
            const fullPath = `${root}/${path}`
            if (!this.scanSubPackagesMap.has(fullPath)) {
              // 非扫描忽略
              continue
            }

            const route = this.scanSubPackagesMap.get(fullPath)!

            // 是否存在在配置中，有则需要合并
            const rootIdx = pageMeta.subPackages!.findIndex(
              packages => packages.root === root,
            )
            const pageIdx
              = rootIdx === -1
                ? -1
                : pageMeta.subPackages![rootIdx].pages?.findIndex(
                    p => p.path === path,
                  )

            if (rootIdx !== -1 && pageIdx !== -1) {
              jsoncAssign(
                forbiddenOverwritePagePath(
                  pageMeta.subPackages![rootIdx].pages![pageIdx],
                  'path',
                  path,
                ),
                route.content,
              )
              continue
            }

            // 不存在于原有配置，则新增
            let subPackageItem: SubPackage | undefined
            if (rootIdx === -1) {
              subPackageItem = {
                root,
                pages: [],
              }
              pageMeta.subPackages!.push(subPackageItem)
            }
            else {
              subPackageItem = pageMeta.subPackages![rootIdx]
            }

            if (!subPackageItem.pages) {
              subPackageItem.pages = []
            }

            subPackageItem.pages.push(
              jsoncAssign(
                forbiddenOverwritePagePath({}, 'path', path),
                route.content,
              ) as any,
            )
          }
        }
      }

      // 处理分包内页面排序
      pageMeta.subPackages?.forEach((subPackage) => {
        if (!subPackage.pages) {
          return
        }

        subPackage.pages
          .sort((a, b) => {
            const pageA = a.path
            const pageB = b.path
            return pageA.localeCompare(pageB)
          })
          .sort((a, b) => {
            const fullPathA = `${subPackage.root}/${a.path}`
            const fullPathB = `${subPackage.root}/${b.path}`
            const routeA = this.scanSubPackagesMap.get(fullPathA)
            const routeB = this.scanSubPackagesMap.get(fullPathB)
            const seqA
              = routeA?.seq ?? originalPathSeqMap.get(fullPathA) ?? DEFAULT_SEQ
            const seqB
              = routeB?.seq ?? originalPathSeqMap.get(fullPathB) ?? DEFAULT_SEQ
            return seqA - seqB
          })
      })

      // 处理pages排序 先根据路径字符串排序，再根据 seq 排序，如果包含在tabBar中则优先级取决于tabBar的seq
      pageMeta.pages
        // 先根据路径字符串排序，确保相同路径时排序稳定
        .sort((a, b) => {
          const pageA = a.path
          const pageB = b.path
          return pageA.localeCompare(pageB)
        })
        // tabBar 路径优先排序
        .sort((a, b) => {
          const tabBarA = pageMeta.tabBar?.list?.find(
            item => item.pagePath === a.path,
          )
          const tabBarB = pageMeta.tabBar?.list?.find(
            item => item.pagePath === b.path,
          )
          if (tabBarA && tabBarB) {
            // 如果都在 tabBar 中，则根据 tabBar 的顺序排序
            return (
              pageMeta.tabBar!.list!.indexOf(tabBarA)
              - pageMeta.tabBar!.list!.indexOf(tabBarB)
            )
          }
          else if (tabBarA) {
            // 如果只有 A 在 tabBar 中，则 A 优先
            return -1
          }
          else if (tabBarB) {
            // 如果只有 B 在 tabBar 中，则 B 优先
            return 1
          }
          else {
            // 如果都不在 tabBar 中，则根据 seq 排序
            const routeA = this.scanPagesMap.get(a.path)
            const routeB = this.scanPagesMap.get(b.path)
            const seqA
              = routeA?.seq ?? originalPathSeqMap.get(a.path) ?? DEFAULT_SEQ
            const seqB
              = routeB?.seq ?? originalPathSeqMap.get(b.path) ?? DEFAULT_SEQ
            return seqA - seqB
          }
        })

      const jsonStr = jsoncStringify(pageMeta, null, 2)
      const isSame = await compareStringWithFile(jsonStr, this.options.outputJsonPath)
      if (isSame) {
        return
      }

      await atomicWriteFile(
        this.options.outputJsonPath,
        jsonStr,
        { encoding: 'utf-8' },
      )
      // console.log(
      //   `[unplugin-uni-pages] ${this.options.outputJsonPath} generated.`,
      // )
    }
    catch (error) {
      console.log(
        `[unplugin-uni-pages] ${this.options.outputJsonPath} generation failed.`,
      )
      console.error(error instanceof Error ? error.message : `${error}`)
    }
    finally {
      if (release) {
        await release()
      }
    }
  }

  async resolveVirtualModule() {
    const pagesStr = await fs.promises.readFile(this.options.outputJsonPath, {
      encoding: 'utf-8',
    })
    let routes: string = '[]'
    let subRoutes: string = '[]'
    try {
      const pages = jsoncParse(pagesStr) as Record<string, any>
      routes = jsoncStringify(pages.pages || [], null, 2)
      subRoutes = jsoncStringify(pages.subPackages || [], null, 2)
    }
    catch {
      // ignore
    }

    const pages = `export const pages = ${routes};`
    const subPackages = `export const subPackages = ${subRoutes};`
    return [pages, subPackages].join('\n')
  }

  async scan() {
    // reset
    this.scanPagesMap.clear()
    this.scanSubPackagesMap.clear()
    this.scanTabBarMap.clear()

    if (!this.options.scanDir || this.options.scanDir.length === 0) {
      return
    }

    const scanFiles: string[] = []
    const ext = `**/*.${extsToGlob(FILE_EXTENSIONS)}`
    this.options.scanDir.forEach((dir) => {
      const files = globSync(ext, {
        cwd: dir,
        ignore: this.options.exclude,
        absolute: true,
        onlyFiles: true,
      })
      scanFiles.push(...files)
    })

    for (const file of scanFiles) {
      try {
        const code = await fs.promises.readFile(file, { encoding: 'utf-8' })
        const sfc = parseSFC(code, { filename: file })
        const routeBlocks = getRouteSfcBlock(sfc)?.map(
          b => parseCustomBlock(b, file)!,
        )
        if (!routeBlocks || routeBlocks.length === 0) {
          continue
        }

        // remove file extension and leading slash
        const routePath = slash(
          path.relative(this.options.inputDir, file),
        ).replace(new RegExp(`\\.(${FILE_EXTENSIONS.join('|')})$`), '')

        const onFilterResult = async (pagePath: string, filePath: string, blocks: ScanPageRouteBlock[]) => {
          try {
            if (this.options.onScanPageFilter) {
              return await this.options.onScanPageFilter(pagePath, filePath, blocks)
            }
          }
          catch {
            return undefined
          }
        }

        const filterResult = await onFilterResult(routePath, file, routeBlocks)
        if (filterResult === false) {
          continue
        }

        for (const block of routeBlocks) {
          if (block.part === 'page') {
            this.scanPagesMap.set(routePath, block)
          }
          else if (block.part === 'subPackage') {
            this.scanSubPackagesMap.set(routePath, block)
          }
          else if (block.part === 'tabBar') {
            this.scanTabBarMap.set(routePath, block)
          }
          else {
            // 不符合要求的 part，输出警告
            console.warn(
              `[unplugin-uni-pages] warning: invalid part "${block.part}" in route block of file ${file}. Expected "page", "subPackage", or "tabBar".`,
            )
          }
        }
      }
      catch (err: any) {
        console.error(`[unplugin-uni-pages] ${err.message}`)
      }
    }
  }
}
