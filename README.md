# MangaDex API 代理服务

一个基于 Express.js 的 MangaDex API 代理服务，符合自定义漫画源格式要求，支持图片代理、缓存和优化功能。

## 📋 功能特性

- **漫画搜索**：支持关键词搜索和分页
- **漫画详情**：获取漫画信息、评分、标签和章节统计
- **图片阅读**：获取漫画章节图片，支持章节选择
- **图片代理**：自动调整图片尺寸和质量，优化加载速度
- **智能缓存**：搜索结果和封面图片缓存机制
- **错误处理**：完善的错误处理和用户友好的提示

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install express mangadex-full-api axios sharp
```

### 2. 运行服务

```bash
node app.js
```

服务将在 `http://localhost:3000` 启动。

## 📖 API 文档

### 配置文件
- **路径**: `GET /config`
- **描述**: 获取服务配置信息，用于漫画阅读器集成
- **返回格式**:
```json
{
  "MangaDex": {
    "name": "MangaDex",
    "apiUrl": "http://your-domain.com",
    "detailPath": "/comic/<id>",
    "photoPath": "/photo/<id>/ch/<chapter>",
    "searchPath": "/search/<text>/<page>",
    "type": "mangedex"
  }
}
```

### 搜索漫画
- **路径**: `GET /search/:text` 或 `GET /search/:text/:page`
- **参数**:
    - `text`: 搜索关键词
    - `page`: 页码（可选，默认第1页）
- **返回格式**:
```json
{
  "page": 1,
  "has_more": true,
  "current_page_results": 10,
  "results": [
    {
      "comic_id": "manga-uuid",
      "title": "漫画标题",
      "cover_url": "https://your-domain.com/image/proxy?url=..."
    }
  ]
}
```

### 获取漫画详情
- **路径**: `GET /comic/:id`
- **参数**: `id`: MangaDex 漫画UUID
- **返回格式**:
```json
{
  "item_id": "manga-uuid",
  "name": "漫画标题",
  "page_count": 500,
  "rate": 8.5,
  "cover": "https://your-domain.com/image/proxy?url=...&width=256",
  "tags": "标签1, 标签2",
  "total_chapters": 50
}
```

### 获取漫画图片
- **路径**: `GET /photo/:id` 或 `GET /photo/:id/ch/:chapter`
- **参数**:
    - `id`: 漫画UUID
    - `chapter`: 章节号（可选，默认第1章）
- **返回格式**:
```json
{
  "title": "章节标题",
  "images": [
    {"url": "https://your-domain.com/image/proxy?url=..."},
    {"url": "https://your-domain.com/image/proxy?url=..."}
  ]
}
```

### 图片代理服务
- **路径**: `GET /image/proxy`
- **查询参数**:
    - `url`: 原始图片URL（必需）
    - `width`: 目标宽度（默认600）
    - `quality`: JPEG质量（默认50）
- **描述**: 下载、调整大小、压缩并返回优化后的图片

## 🔧 配置说明

### 环境变量（可选）
创建 `.env` 文件：
```env
PORT=3000
CACHE_TTL=30000
MAX_CHAPTERS=2000
```

### 修改端口
在 `app.js` 中修改：
```javascript
const port = process.env.PORT || 3000;
```

### 缓存配置
```javascript
const CACHE_TTL = 30000; // 30秒缓存时间
const MAX_CHAPTERS = 2000; // 最大获取章节数
```

## 📁 项目结构

```
mangadex-api/
├── app.js              # 主应用程序文件
├── package.json        # 依赖配置
├── .env               # 环境变量（可选）
└── README.md          # 说明文档
```

## ⚙️ 部署建议

### 1. 反向代理配置（Nginx）
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

### 2. PM2 进程管理
```bash
npm install -g pm2
pm2 start app.js --name "mangadex-api"
pm2 save
pm2 startup
```

### 3. Docker 部署
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
```

## 🔍 故障排除

### 常见问题

1. **封面图片无法加载**
    - 检查网络连接
    - 确认 MangaDex API 服务正常
    - 查看控制台日志

2. **搜索无结果**
    - 确认搜索关键词正确
    - 检查 MangaDex 服务状态
    - 查看是否有网络限制

3. **图片代理失败**
    - 检查原始图片URL是否有效
    - 确认 sharp 库正确安装
    - 查看内存使用情况

### 调试模式
在代码中添加调试路由：
```javascript
app.get("/debug", (req, res) => {
  res.json({
    status: "online",
    version: "1.0.0",
    cache_size: searchCache.size
  });
});
```

## 📊 性能优化建议

1. **启用缓存**：搜索结果默认缓存30秒
2. **图片优化**：图片代理自动调整尺寸和质量
3. **批量处理**：章节获取使用分页机制
4. **错误恢复**：网络错误时自动重试和降级处理

## 🤝 贡献指南

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## ⚠️ 注意事项

- 本项目仅为 MangaDex API 的代理服务，不存储任何漫画内容
- 请遵守 MangaDex 的使用条款和服务条款
- 建议在生产环境中配置适当的速率限制
- 定期更新依赖包以确保安全性

## 📞 支持

如有问题或建议，请：
1. 查看现有 Issues
2. 开启新的 Issue
3. 查看代码注释和文档