const express = require("express")
const { Manga, Chapter } = require("mangadex-full-api")
const app = express()
const port = process.env.PORT || 3000

const axios = require("axios")
const sharp = require("sharp")

process.on("uncaughtException", (error) => {
  console.error("=== 未捕获的异常 ===")
  console.error("时间:", new Date().toISOString())
  console.error("错误名称:", error.name)
  console.error("错误信息:", error.message)
  console.error("错误堆栈:", error.stack)
  console.error("====================")
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("=== 未处理的 Promise 拒绝 ===")
  console.error("时间:", new Date().toISOString())
  console.error("拒绝原因:", reason)
  console.error("Promise:", promise)
  console.error("============================")
})

// 图片处理并发限制
const MAX_CONCURRENT_IMAGE_REQUESTS = 5
const MAX_QUEUE_SIZE = 50
let activeImageRequests = 0
const imageRequestQueue = []

async function processImageRequest(req, res) {
  const startTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)
  const queueIndex = imageRequestQueue.findIndex(item => item.req === req)
  if (queueIndex !== -1) {
    imageRequestQueue.splice(queueIndex, 1)
  }

  console.log(`[图片请求 ${requestId}] 开始处理 - URL: ${req.query.url?.substring(0, 50)}...`)

  try {
    activeImageRequests++
    
    const imageUrl = req.query.url
    if (!imageUrl) {
      console.log(`[图片请求 ${requestId}] 失败 - 缺少url参数`)
      return res.status(400).json({ error: "缺少url参数" })
    }

    const targetWidth = parseInt(req.query.width) || 600
    const quality = parseInt(req.query.quality) || 50

    console.log(`[图片请求 ${requestId}] 下载图片 - 目标宽度: ${targetWidth}, 质量: ${quality}`)

    const downloadStart = Date.now()
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
      maxRedirects: 3
    })
    const downloadTime = Date.now() - downloadStart

    console.log(`[图片请求 ${requestId}] 下载完成 - 耗时: ${downloadTime}ms, 大小: ${(response.data.byteLength / 1024).toFixed(2)}KB`)

    if (response.status !== 200) {
      console.log(`[图片请求 ${requestId}] 失败 - HTTP状态码: ${response.status}`)
      return res.status(500).json({ error: `图片下载失败: ${response.status}` })
    }

    const contentLength = response.data.byteLength
    if (contentLength > 50 * 1024 * 1024) {
      console.log(`[图片请求 ${requestId}] 失败 - 图片过大: ${(contentLength / 1024 / 1024).toFixed(2)}MB`)
      return res.status(413).json({ error: "图片过大，最大支持 50MB" })
    }

    console.log(`[图片请求 ${requestId}] 开始处理图片...`)
    const processStart = Date.now()
    
    let sharpInstance = sharp(response.data, {
      limitInputPixels: 268402689
    })
    
    const imageBuffer = await sharpInstance
      .resize({
        width: targetWidth,
        height: null,
        fit: sharp.fit.inside,
        withoutEnlargement: true
      })
      .jpeg({ 
        quality: quality,
        progressive: true,
        mozjpeg: true
      })
      .toBuffer()
    const processTime = Date.now() - processStart

    sharpInstance = null

    console.log(`[图片请求 ${requestId}] 图片处理完成 - 耗时: ${processTime}ms, 输出大小: ${(imageBuffer.length / 1024).toFixed(2)}KB`)

    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400"
    })

    res.send(imageBuffer)

    const totalTime = Date.now() - startTime
    console.log(`[图片请求 ${requestId}] 成功完成 - 总耗时: ${totalTime}ms`)
  } catch (error) {
    const totalTime = Date.now() - startTime
    console.error(`[图片请求 ${requestId}] 失败 - 耗时: ${totalTime}ms`)
    console.error(`[图片请求 ${requestId}] 错误名称: ${error.name}`)
    console.error(`[图片请求 ${requestId}] 错误信息: ${error.message}`)
    console.error(`[图片请求 ${requestId}] 错误代码: ${error.code}`)
    console.error(`[图片请求 ${requestId}] 错误堆栈: ${error.stack}`)

    if (error.response) {
      console.error(`[图片请求 ${requestId}] HTTP响应状态: ${error.response.status}`)
      return res.status(error.response.status).json({
        error: `图片下载失败: ${error.response.status}`
      })
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      console.error(`[图片请求 ${requestId}] 请求超时`)
      return res.status(504).json({ error: "请求超时" })
    }

    res.status(500).json({ error: `图片处理失败: ${error.message}` })
  } finally {
    activeImageRequests--
    console.log(`[图片请求 ${requestId}] 结束 - 活跃请求: ${activeImageRequests}, 队列长度: ${imageRequestQueue.length}`)
    processNextImageRequest()
  }
}

function processNextImageRequest() {
  if (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS && imageRequestQueue.length > 0) {
    const nextRequest = imageRequestQueue.shift()
    processImageRequest(nextRequest.req, nextRequest.res)
  }
}

// 解析 JSON 请求体
app.use(express.json())

// 设置请求超时
app.use((req, res, next) => {
  res.setTimeout(60000, () => {
    console.log(`请求超时: ${req.method} ${req.url}`)
    res.status(504).json({ error: "请求超时" })
  })
  next()
})

// 首页路由
app.get("/", (req, res) => {
  res.send("MangaDex API 服务运行中！")
})

/**
 * 图片代理接口，处理图片尺寸和质量
 * 使用示例：/image/proxy?url=https://example.com/image.jpg&width=600&quality=50
 */
app.get("/image/proxy", (req, res) => {
  if (imageRequestQueue.length >= MAX_QUEUE_SIZE) {
    return res.status(429).json({ error: "请求过多，请稍后再试" })
  }

  if (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS) {
    processImageRequest(req, res)
  } else {
    imageRequestQueue.push({ req, res })
    console.log(`图片请求已排队，当前队列长度: ${imageRequestQueue.length}`)
  }
})

// 配置路由
app.get("/config", (req, res) => {
  const config = {
    MangaDex: {
      name: "MangaDex",
      apiUrl: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`,
      detailPath: "/comic/<id>",
      photoPath: "/photo/<id>/ch/<chapter>",
      searchPath: "/search/<text>/<page>",
      type: "mangedex"
    }
  }
  res.setHeader("Content-Type", "application/json")
  res.send(config)
})

// 添加一个内存缓存来临时存储下一页数据
const searchCache = new Map()
const CACHE_TTL = 30000 // 30秒
const MAX_CACHE_SIZE = 100 // 最大缓存条目数

function addToCache(key, data) {
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value
    searchCache.delete(oldestKey)
  }
  searchCache.set(key, { data, timestamp: Date.now() })
}

function getPreferredTitle(titleObj) {
  if (!titleObj || typeof titleObj !== "object") {
    return "untitled"
  }

  if (titleObj.en) {
    // 优先级：en -> ja-ro -> 第一个可用的标题
    return titleObj.en
  }

  if (titleObj["ja-ro"]) {
    return titleObj["ja-ro"]
  }

  // 如果没有 en 或 ja-ro，获取第一个可用的标题
  const firstAvailableKey = Object.keys(titleObj)[0]
  if (firstAvailableKey) {
    return titleObj[firstAvailableKey]
  }

  return "untitled"
}

app.get(["/search/:text", "/search/:text/:page"], async (req, res) => {
  const startTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)
  
  try {
    const searchText = req.params.text
    const currentPage = parseInt(req.params.page) || 1
    const limit = 10
    const offset = (currentPage - 1) * limit

    console.log(`[搜索请求 ${requestId}] 开始 - 搜索词: ${searchText}, 页码: ${currentPage}`)

    const cacheKey = `${searchText}_${currentPage}`

    // 检查缓存
    const cached = searchCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      const cacheAge = Date.now() - cached.timestamp
      console.log(`[搜索请求 ${requestId}] 使用缓存 - 缓存年龄: ${cacheAge}ms`)
      res.setHeader("Content-Type", "application/json")
      return res.json(cached.data)
    }

    console.log(`[搜索请求 ${requestId}] 缓存未命中，开始查询 MangaDex API...`)

    // 获取当前页和下一页的数据
    const searchStart = Date.now()
    const [currentPageResults, nextPageCheck] = await Promise.all([
      // 当前页数据
      Manga.search({
        title: searchText,
        limit: limit,
        offset: offset,
        hasAvailableChapters: true,
        contentRating: ["safe", "suggestive", "erotica", "pornographic"],
        order: { relevance: "desc" }
      }),
      // 下一页的第一条数据（用于判断是否有更多）
      Manga.search({
        title: searchText,
        limit: 1,
        offset: offset + limit,
        hasAvailableChapters: true,
        contentRating: ["safe", "suggestive", "erotica", "pornographic"],
        order: { relevance: "desc" }
      })
    ])
    const searchTime = Date.now() - searchStart

    console.log(`[搜索请求 ${requestId}] MangaDex API 查询完成 - 耗时: ${searchTime}ms, 结果数: ${currentPageResults.length}`)

    // 处理当前页漫画的封面
    console.log(`[搜索请求 ${requestId}] 开始获取封面图片...`)
    const coverStart = Date.now()
    const results = await Promise.all(
      currentPageResults.map(async (manga) => {
        const preferredTitle = getPreferredTitle(manga.title)
        await manga.mainCover.resolve()

        let coverImageUrl
        if (manga.mainCover && manga.mainCover.id) {
          try {
            const coverResponse = await axios.get(
              `https://api.mangadex.org/cover/${manga.mainCover.id}`,
              { timeout: 5000 }
            )
            const fileName = coverResponse.data.data.attributes.fileName
            coverImageUrl = `https://uploads.mangadex.org/covers/${manga.id}/${fileName}.256.jpg`
          } catch (coverErr) {
            console.error(`[搜索请求 ${requestId}] 获取封面 ${manga.mainCover.id} 失败:`, coverErr.message)
          }
        }
        return {
          comic_id: manga.id,
          title: preferredTitle,
          cover_url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${coverImageUrl}&width=100`
        }
      })
    )
    const coverTime = Date.now() - coverStart

    console.log(`[搜索请求 ${requestId}] 封面获取完成 - 耗时: ${coverTime}ms`)

    // 判断是否有下一页
    const hasMore = nextPageCheck.length > 0

    const response = {
      page: currentPage,
      has_more: hasMore,
      current_page_results: results.length,
      results: results
    }

    // 存入缓存
    addToCache(cacheKey, response)

    // 清理过期缓存
    setTimeout(() => {
      searchCache.delete(cacheKey)
    }, CACHE_TTL)

    const totalTime = Date.now() - startTime
    console.log(`[搜索请求 ${requestId}] 成功完成 - 总耗时: ${totalTime}ms, 结果数: ${results.length}, 下一页: ${hasMore}`)

    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    const totalTime = Date.now() - startTime
    console.error(`[搜索请求 ${requestId}] 失败 - 耗时: ${totalTime}ms`)
    console.error(`[搜索请求 ${requestId}] 错误名称: ${error.name}`)
    console.error(`[搜索请求 ${requestId}] 错误信息: ${error.message}`)
    console.error(`[搜索请求 ${requestId}] 错误代码: ${error.code}`)
    console.error(`[搜索请求 ${requestId}] 错误堆栈: ${error.stack}`)
    res.status(500).json({ error: "搜索失败" })
  }
})

/**
 * 辅助函数：获取封面图片URL
 */
async function getCoverImageUrl(mangaId, coverId) {
  if (!coverId) {
    return `https://via.placeholder.com/400x600/333/ccc?text=No+Cover`
  }

  try {
    // 尝试获取封面详情
    const response = await axios.get(`https://api.mangadex.org/cover/${coverId}`, {
      timeout: 5000
    })

    if (response.data?.data?.attributes?.fileName) {
      const fileName = response.data.data.attributes.fileName
      return `https://uploads.mangadex.org/covers/${mangaId}/${fileName}.256.jpg`
    }
  } catch (error) {
    console.warn(`封面 ${coverId} 获取失败:`, error.message)
  }
}

/**
 * 漫画详情路由
 * GET /comic/:id
 * 返回格式：
 * {
 *   "item_id": 114514,
 *   "name": "comicName",
 *   "page_count": 24,
 *   "views": 1919810,
 *   "rate": 9.0,
 *   "cover": "https://youapicover.domain",
 *   "tags": ""
 * }
 */
app.get("/comic/:id", async (req, res) => {
  const startTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)
  
  try {
    const mangaId = req.params.id

    console.log(`[漫画详情请求 ${requestId}] 开始 - 漫画ID: ${mangaId}`)

    // 验证ID格式（MangaDex UUID格式）
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mangaId)) {
      console.log(`[漫画详情请求 ${requestId}] 失败 - 无效的UUID格式`)
      return res.status(400).json({
        error: "无效的漫画ID格式",
        expected_format: "UUID格式，例如: 32d76d19-8a05-4db0-9fc2-e0b0648fe9d0"
      })
    }

    // 1. 获取漫画基本信息
    console.log(`[漫画详情请求 ${requestId}] 获取漫画基本信息...`)
    const manga = await Manga.get(mangaId)
    console.log(`[漫画详情请求 ${requestId}] 获取统计数据...`)
    const statistics = await manga.getStatistics()

    // 2. 获取封面URL
    console.log(`[漫画详情请求 ${requestId}] 获取封面URL...`)
    const coverUrl = await getCoverImageUrl(manga.id, manga.mainCover?.id)

    // 3. 获取所有章节（分页获取）
    console.log(`[漫画详情请求 ${requestId}] 开始获取章节列表...`)
    const allChapters = []
    let offset = 0
    const limit = 100
    let hasMore = true
    let batchCount = 0

    while (hasMore) {
      try {
        batchCount++
        console.log(`[漫画详情请求 ${requestId}] 获取章节批次 ${batchCount} (offset: ${offset})...`)
        
        const chaptersBatch = await manga.getFeed({
          translatedLanguage: ["en"],
          order: { chapter: "asc" },
          limit: limit,
          offset: offset,
          includeExternalUrl: "0",
          contentRating: ["safe", "suggestive", "erotica", "pornographic"]
        })

        if (chaptersBatch.length === 0) {
          hasMore = false
        } else {
          allChapters.push(...chaptersBatch)
          offset += limit
          console.log(`[漫画详情请求 ${requestId}] 批次 ${batchCount} 完成 - 获取 ${chaptersBatch.length} 章, 总计 ${allChapters.length} 章`)

          if (allChapters.length >= 2000) {
            console.warn(`[漫画详情请求 ${requestId}] 章节数超过2000，已截断`)
            hasMore = false
          }
        }
      } catch (batchError) {
        console.error(`[漫画详情请求 ${requestId}] 获取章节批次失败 (offset: ${offset}):`, batchError.message)
        hasMore = false
      }
    }

    console.log(`[漫画详情请求 ${requestId}] 章节获取完成 - 总章节数: ${allChapters.length}, 批次数: ${batchCount}`)

    // 4. 计算总页数
    const exactPageCount = allChapters.reduce((total, chapter) => {
      return total + (chapter.pages || 0)
    }, 0)

    console.log(`[漫画详情请求 ${requestId}] 总页数: ${exactPageCount}`)

    // 5. 构建响应数据（严格遵循格式）
    let response = {
      item_id: manga.id,
      name: getPreferredTitle(manga.title),
      page_count: exactPageCount,
      rate: parseFloat(statistics.rating.bayesian.toFixed(2)),
      cover: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${coverUrl}&width=256`,
      tags: manga.tags ? manga.tags.map((tag) => tag.name.en) : ""
    }

    if (allChapters.length > 0) {
      response.total_chapters = allChapters.length
    }

    const totalTime = Date.now() - startTime
    console.log(`[漫画详情请求 ${requestId}] 成功完成 - 总耗时: ${totalTime}ms`)

    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    const totalTime = Date.now() - startTime
    console.error(`[漫画详情请求 ${requestId}] 失败 - 耗时: ${totalTime}ms`)
    console.error(`[漫画详情请求 ${requestId}] 错误名称: ${error.name}`)
    console.error(`[漫画详情请求 ${requestId}] 错误信息: ${error.message}`)
    console.error(`[漫画详情请求 ${requestId}] 错误代码: ${error.code}`)
    console.error(`[漫画详情请求 ${requestId}] 错误堆栈: ${error.stack}`)

    if (error.message.includes("not found") || error.message.includes("不存在")) {
      return res.status(404).json({
        error: "漫画不存在",
        manga_id: req.params.id
      })
    }

    res.status(500).json({
      error: "获取漫画详情失败",
      manga_id: req.params.id,
      message: error.message
    })
  }
})

/**
 * 获取漫画图片路由
 * GET /photo/:id
 * 返回格式：
 * {
 *   "title": "comicName",
 *   "images": [
 *     {"url": "https://youapiphoto1.domain?width=600&quality=50"},
 *     {"url": "https://youapiphoto2.domain?width=600&quality=50"}
 *   ]
 * }
 */
app.get(["/photo/:id", "/photo/:id/ch/:ch"], async (req, res) => {
  const startTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)
  
  try {
    const mangaId = req.params.id
    const currentChapter = req.params.ch || 1

    console.log(`[漫画图片请求 ${requestId}] 开始 - 漫画ID: ${mangaId}, 章节: ${currentChapter}`)

    // 1. 获取漫画基本信息
    console.log(`[漫画图片请求 ${requestId}] 获取漫画基本信息...`)
    const manga = await Manga.get(mangaId)
    const mangaTitle = getPreferredTitle(manga.title)
    console.log(`[漫画图片请求 ${requestId}] 漫画标题: ${mangaTitle}`)

    // 2. 获取章节
    console.log(`[漫画图片请求 ${requestId}] 获取章节 ${currentChapter}...`)
    const chapters = await manga.getFeed({
      translatedLanguage: ["en"],
      order: { chapter: "asc" },
      limit: 1,
      offset: currentChapter - 1,
      includeExternalUrl: "0",
      contentRating: ["safe", "suggestive", "erotica", "pornographic"]
    })

    if (chapters.length === 0) {
      console.log(`[漫画图片请求 ${requestId}] 失败 - 未找到章节 ${currentChapter}`)
      return res.status(404).json({
        error: "未找到章节",
        manga_id: mangaId
      })
    }

    console.log(`[漫画图片请求 ${requestId}] 章节找到 - ID: ${chapters[0].id}`)

    // 3. 获取章节图片
    console.log(`[漫画图片请求 ${requestId}] 获取章节图片列表...`)
    const chapter = chapters[0]
    const readablePages = await chapter.getReadablePages()

    console.log(`[漫画图片请求 ${requestId}] 图片列表获取完成 - 图片数量: ${readablePages.length}`)

    // 4. 构建图片URL数组
    const images = readablePages.map((url) => ({
      url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${url}`
    }))

    // 5. 返回响应
    const response = {
      title: chapter.title || mangaTitle,
      images: images
    }

    const totalTime = Date.now() - startTime
    console.log(`[漫画图片请求 ${requestId}] 成功完成 - 总耗时: ${totalTime}ms, 图片数量: ${images.length}`)

    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    const totalTime = Date.now() - startTime
    console.error(`[漫画图片请求 ${requestId}] 失败 - 耗时: ${totalTime}ms`)
    console.error(`[漫画图片请求 ${requestId}] 错误名称: ${error.name}`)
    console.error(`[漫画图片请求 ${requestId}] 错误信息: ${error.message}`)
    console.error(`[漫画图片请求 ${requestId}] 错误代码: ${error.code}`)
    console.error(`[漫画图片请求 ${requestId}] 错误堆栈: ${error.stack}`)

    if (error.message.includes("not found") || error.message.includes("不存在")) {
      return res.status(404).json({
        error: "漫画不存在",
        manga_id: req.params.id
      })
    }

    res.status(500).json({
      error: "获取漫画图片失败",
      manga_id: req.params.id
    })
  }
})

// 错误处理中间件
app.use((err, req, res, next) => {
  const requestId = Math.random().toString(36).substring(7)
  console.error(`[错误处理 ${requestId}] 捕获到未处理的错误`)
  console.error(`[错误处理 ${requestId}] 请求路径: ${req.method} ${req.url}`)
  console.error(`[错误处理 ${requestId}] 错误名称: ${err.name}`)
  console.error(`[错误处理 ${requestId}] 错误信息: ${err.message}`)
  console.error(`[错误处理 ${requestId}] 错误堆栈: ${err.stack}`)
  res.status(500).json({ error: "服务器内部错误" })
})

// 404 处理
app.use((req, res) => {
  console.log(`[404] 路由未找到 - ${req.method} ${req.url}`)
  res.status(404).json({ error: "路由未找到" })
})

// 启动服务器
const server = app.listen(port, () => {
  console.log("========================================")
  console.log("MangaDex API 服务启动成功")
  console.log("========================================")
  console.log(`服务地址: http://localhost:${port}`)
  console.log(`配置地址: http://localhost:${port}/config`)
  console.log(`环境: ${process.env.NODE_ENV || 'development'}`)
  console.log(`启动时间: ${new Date().toISOString()}`)
  console.log("========================================")
})

// 优雅关闭
const gracefulShutdown = (signal) => {
  console.log("========================================")
  console.log(`收到 ${signal} 信号，开始优雅关闭...`)
  console.log(`关闭时间: ${new Date().toISOString()}`)
  console.log(`当前活跃图片请求: ${activeImageRequests}`)
  console.log(`当前队列长度: ${imageRequestQueue.length}`)
  console.log(`当前缓存大小: ${searchCache.size}`)
  console.log("========================================")
  
  server.close(() => {
    console.log("HTTP 服务器已关闭")
    process.exit(0)
  })

  setTimeout(() => {
    console.error("========================================")
    console.error("强制关闭超时，退出进程")
    console.error("========================================")
    process.exit(1)
  }, 10000)
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
