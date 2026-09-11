const express = require('express')
const path = require('node:path')
const { logger } = require('./logger')

// The standalone build substitutes tools/binary-frontend.mjs for this module.
function mountFrontend(application) {
  const frontendDirectory = path.resolve(__dirname, '../../public/dist')
  application.use(express.static(frontendDirectory))
  application.get('*', (request, response) => {
    response.sendFile(path.join(frontendDirectory, 'index.html'), error => {
      if (error) {
        logger.error('Failed to serve the dashboard', 'SERVER', '', error)
        if (!response.headersSent) response.status(500).send('Internal server error')
      }
    })
  })
}

module.exports = { mountFrontend }
