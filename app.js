const express = require("express")
const { Manga, Chapter } = require("mangadex-full-api")
const app = express()
const port = 3000

const axios = require("axios")
const sharp = require("sharp")

// 解析 JSON 请求体
app.use(express.json())

// 首页路由
app.get("/", (req, res) => {
  res.send("MangaDex API 服务运行中！")
})

/**
 * 图片代理接口，处理图片尺寸和质量
 * 使用示例：/image/proxy?url=https://example.com/image.jpg&width=600&quality=50
 */
app.get("/image/proxy", async (req, res) => {
  try {
    // 获取参数
    const imageUrl = req.query.url
    if (!imageUrl) {
      return res.status(400).json({ error: "缺少url参数" })
    }

    const targetWidth = parseInt(req.query.width) || 600
    const quality = parseInt(req.query.quality) || 50

    // 下载原始图片
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 30000
    })

    if (response.status !== 200) {
      return res.status(500).json({ error: `图片下载失败: ${response.status}` })
    }

    // 处理图片
    const imageBuffer = await sharp(response.data)
      .resize({
        width: targetWidth,
        height: null, // 自动计算高度保持比例
        fit: sharp.fit.inside,
        withoutEnlargement: true
      })
      .jpeg({ quality: quality })
      .toBuffer()

    // 返回处理后的图片
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400"
    })

    res.send(imageBuffer)
  } catch (error) {
    console.error("图片处理失败:", error.message)

    if (error.response) {
      return res.status(error.response.status).json({
        error: `图片下载失败: ${error.response.status}`
      })
    }

    res.status(500).json({ error: `图片处理失败: ${error.message}` })
  }
})

// 配置路由
app.get("/config", (req, res) => {
  const config = {
    MangaDex: {
      name: "MangaDex",
      apiUrl: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`,
      detailPath: "/comic/<id>",
      photoPath: "/photo/<id>",
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
  try {
    const searchText = req.params.text
    const currentPage = parseInt(req.params.page) || 1
    const limit = 10
    const offset = (currentPage - 1) * limit

    const cacheKey = `${searchText}_${currentPage}`

    // 检查缓存
    const cached = searchCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`使用缓存数据: ${cacheKey}`)
      res.setHeader("Content-Type", "application/json")
      return res.json(cached.data)
    }

    // 获取当前页和下一页的数据
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

    // 处理当前页漫画的封面
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
            const fileName = coverResponse.data.data.attributes.fileName // 关键字段
            coverImageUrl = `https://uploads.mangadex.org/covers/${manga.id}/${fileName}.256.jpg`
          } catch (coverErr) {
            console.error(`获取封面 ${manga.mainCover.id} 详情失败:`, coverErr.message)
          }
        }
        return {
          comic_id: manga.id,
          title: preferredTitle,
          cover_url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${coverImageUrl}&width=100`
        }
      })
    )

    // 判断是否有下一页
    const hasMore = nextPageCheck.length > 0

    const response = {
      page: currentPage,
      has_more: hasMore,
      current_page_results: results.length,
      results: results
    }

    // 存入缓存
    searchCache.set(cacheKey, {
      data: response,
      timestamp: Date.now()
    })

    // 清理过期缓存
    setTimeout(() => {
      searchCache.delete(cacheKey)
    }, CACHE_TTL)

    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    console.error("搜索漫画时出错:", error)
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
  try {
    const mangaId = req.params.id

    // 验证ID格式（MangaDex UUID格式）
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mangaId)) {
      return res.status(400).json({
        error: "无效的漫画ID格式",
        expected_format: "UUID格式，例如: 32d76d19-8a05-4db0-9fc2-e0b0648fe9d0"
      })
    }

    console.log(`获取漫画详情: ${mangaId}`)

    // 1. 获取漫画基本信息
    const manga = await Manga.get(mangaId)
    const statistics = await manga.getStatistics()

    // 2. 并行获取所需数据
    const [coverUrl, chapters] = await Promise.all([
      // 获取封面URL
      getCoverImageUrl(manga.id, manga.mainCover?.id),
      // 获取章节列表
      manga
        .getFeed({
          translatedLanguage: ["en"],
          order: { chapter: "asc" },
          limit: 1,
          contentRating: ["safe", "suggestive", "erotica", "pornographic"]
        })
        .catch(() => []) // 章节获取失败返回空数组
    ])

    const estimatedPageCount = chapters[0].pages

    // 4. 构建响应数据（严格遵循格式）
    const response = {
      item_id: manga.id, // 漫画ID
      name: getPreferredTitle(manga.title), // 漫画名称
      page_count: estimatedPageCount, // 漫画页数
      rate: parseFloat(statistics.rating.bayesian.toFixed(2)), // 漫画评分
      cover: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${coverUrl}&width=256`, // 漫画封面
      tags: manga.tags ? manga.tags.map((tag) => tag.name.en) : "" // 漫画标签
    }

    // 5. 发送响应
    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    console.error(`获取漫画详情失败 (ID: ${req.params.id}):`, error.message)

    // 根据错误类型返回不同的状态码
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
app.get("/photo/:id", async (req, res) => {
  try {
    const mangaId = req.params.id

    // 1. 获取漫画基本信息
    const manga = await Manga.get(mangaId)
    const mangaTitle = getPreferredTitle(manga.title)

    // 2. 获取第一章
    const chapters = await manga.getFeed({
      translatedLanguage: ["en"],
      order: { chapter: "asc" },
      limit: 1,
      contentRating: ["safe", "suggestive", "erotica", "pornographic"]
    })

    if (chapters.length === 0) {
      return res.status(404).json({
        error: "未找到章节",
        manga_id: mangaId
      })
    }

    // 3. 获取章节图片
    const chapter = chapters[0]
    const readablePages = await chapter.getReadablePages()

    // 4. 构建图片URL数组
    const images = readablePages.map((url) => ({
      url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/image/proxy?url=${url}`
    }))

    // 5. 返回响应
    const response = {
      title: mangaTitle,
      images: images
    }

    res.setHeader("Content-Type", "application/json")
    res.json(response)
  } catch (error) {
    console.error(`获取漫画图片失败 (ID: ${req.params.id}):`, error.message)

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
  console.error(err.stack)
  res.status(500).json({ error: "服务器内部错误" })
})

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: "路由未找到" })
})

// 启动服务器
app.listen(port, () => {
  console.log(`MangaDex API 服务运行在 http://localhost:${port}`)
  console.log(`配置地址: http://localhost:${port}/config`)
})
