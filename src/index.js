const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')
const app = express()
const uuid = require('uuid')
const { uploadImage } = require('./image')
require('dotenv').config()

app.use(bodyParser.json({ limit: '128mb' }))
app.use(bodyParser.urlencoded({ limit: '128mb', extended: true }))

const isJson = (str) => {
  try {
    JSON.parse(str)
    return true
  } catch (error) {
    return false
  }
}

app.use((err, req, res, next) => {
  console.error(err) // 输出调试信息
})

app.get(`${process.env.API_PREFIX ? process.env.API_PREFIX : ''}/v1/models`, async (req, res) => {
  try {
    const response = await axios.get('https://chat.qwenlm.ai/api/models',
      {
        headers: {
          "Authorization": req.headers.authorization,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      })
    res.json(response.data)
  } catch (error) {
    res.status(403)
      .json({
        error: "请提供正确的 Authorization token"
      })
  }
})

app.post(`${process.env.API_PREFIX ? process.env.API_PREFIX : ''}/v1/chat/completions`, async (req, res) => {
  if (!req.headers.authorization) {
    return res.status(403)
      .json({
        error: "请提供正确的 Authorization token"
      })
  }

  console.log(`[${new Date().toLocaleString()}]: model: ${req.body.model} | stream: ${req.body.stream}`)

  const messages = req.body.messages
  let imageId = null
  const isImageMessage = Array.isArray(messages[messages.length - 1].content) === true && messages[messages.length - 1].content.filter(item => item.image_url && item.image_url.url).length > 0
  if (isImageMessage) {
    imageId = await uploadImage(messages[messages.length - 1].content.filter(item => item.image_url && item.image_url.url)[0].image_url.url, req.headers.authorization)
    messages[messages.length - 1].content[messages[messages.length - 1].content.length - 1] = {
      "type": "image",
      "image": imageId
    }
  }

  if (req.body.stream === null || req.body.stream === undefined) {
    req.body.stream = false
  }
  const stream = req.body.stream

  const notStreamResponse = async (response) => {
    try {
      const bodyTemplate = {
        "id": `chatcmpl-${uuid.v4()}`,
        "object": "chat.completion",
        "created": new Date().getTime(),
        "model": req.body.model,
        "choices": [
          {
            "index": 0,
            "message": {
              "role": "assistant",
              "content": response.choices[0].message.content
            },
            "finish_reason": "stop"
          }
        ],
        "usage": {
          "prompt_tokens": JSON.stringify(req.body.messages).length,
          "completion_tokens": response.choices[0].message.content.length,
          "total_tokens": JSON.stringify(req.body.messages).length + response.choices[0].message.content.length
        }
      }
      res.json(bodyTemplate)
    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          error: "服务错误!!!"
        })
    }
  }

  const streamResponse = async (response) => {
    try {
      const id = uuid.v4()
      const decoder = new TextDecoder('utf-8')
      let backContent = null
      response.on('data', (chunk) => {
        const decodeText = decoder.decode(chunk)

        const lists = decodeText.split('\n').filter(item => item.trim() !== '')
        for (const item of lists) {
          try {
            const decodeJson = isJson(item.replace(/^data: /, '')) ? JSON.parse(item.replace(/^data: /, '')) : null

            if (decodeJson === null) {
              continue
            }

            // console.log(JSON.stringify(decodeJson))
            let content = decodeJson.choices[0].delta.content

            if (backContent === null) {
              backContent = content
            } else {
              const temp = content
              content = content.replace(backContent, '')
              backContent = temp
            }

            const StreamTemplate = {
              "id": `chatcmpl-${id}`,
              "object": "chat.completion.chunk",
              "created": new Date().getTime(),
              "choices": [
                {
                  "index": 0,
                  "delta": {
                    "content": content
                  },
                  "finish_reason": null
                }
              ]
            }
            res.write(`data: ${JSON.stringify(StreamTemplate)}\n\n`)
          } catch (error) {
            console.log(error)
            res.status(500)
              .json({
                error: "服务错误!!!"
              })
          }
        }
      })

      response.on('end', () => {
        res.write(`data: [DONE]\n\n`)
        res.end()
      })

    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          error: "服务错误!!!"
        })
    }

  }

  try {
    const response = await axios.post('https://chat.qwenlm.ai/api/chat/completions',
      req.body,
      {
        headers: {
          "Authorization": req.headers.authorization,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        responseType: stream ? 'stream' : 'json'
      }
    )

    if (stream) {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      streamResponse(response.data)
    } else {
      res.set({
        'Content-Type': 'application/json',
      })
      notStreamResponse(response.data)
    }

  } catch (error) {
    // console.log(error)
    res.status(500)
      .json({
        error: "罢工了，不干了!!!"
      })
  }

})

app.listen(3000, () => {
  console.log(`服务运行于 http://localhost:3000/${process.env.API_PREFIX ? process.env.API_PREFIX : ''}`)
})

