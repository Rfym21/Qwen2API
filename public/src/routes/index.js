import { createRouter, createWebHistory } from 'vue-router'
import axios from 'axios'

const routes = [
  {
    name: 'dashboard',
    path: '/',
    component: () => import('../views/dashboard.vue')
  },
  {
    name: 'auth',
    path: '/auth',
    component: () => import('../views/auth.vue')
  },
  {
    name: 'settings',
    path: '/settings',
    component: () => import('../views/settings.vue')
  },
  {
    name: 'statistics',
    path: '/statistics',
    component: () => import('../views/statistics.vue')
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})


// 路由守卫
router.beforeEach(async (to, from, next) => {

  if (to.path === '/auth') {
    next()
  } else {
    const apiKey = localStorage.getItem('apiKey')
    if (!apiKey) {
      alert('请先设置身份验证apiKey')
      next({ path: '/auth' })
    } else {
      try {
        const verifyResponse = await axios.post('/verify', {
          apiKey: apiKey
        })

        if (verifyResponse.data.status === 200) {
          const isAdmin = verifyResponse.data.isAdmin

          // 存储用户权限信息
          localStorage.setItem('isAdmin', isAdmin.toString())

          // 检查是否需要管理员权限
          if ((to.path === '/' || to.path === '/settings' || to.path === '/statistics') && !isAdmin) {
            alert('您没有访问管理页面的权限')
            next({ path: '/auth' })
            return
          }

          next()
        } else {
          localStorage.removeItem('apiKey')
          localStorage.removeItem('isAdmin')
          next({ path: '/auth' })
        }
      } catch (error) {
        localStorage.removeItem('apiKey')
        localStorage.removeItem('isAdmin')
        next({ path: '/auth' })
      }
    }
  }

})


export default router