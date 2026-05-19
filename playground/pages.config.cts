// eslint-disable-next-line ts/no-require-imports
const { defineConfig } = require('@uni-aide/unplugin-uni-pages')

const title = 'UNI_APP'

const OUT_SIDE_PAGES: any = [
  {
    path: 'pages/about/about',
    style: {
      // #ifdef MP-ALIPAY
      navigationBarTitleText: 'About Page',
      // #endif
    },
  },
]

module.exports = defineConfig({
  pages: [
    ...OUT_SIDE_PAGES,
    {
      path: 'pages/index/index',
      style: {
        navigationBarTitleText: title,
        // #ifdef H5
        navigationStyle: 'custom',
        // #endif

        // #ifdef MP-WEIXIN
        enablePullDownRefresh: true,
        // #endif
      },
    },
  ],
  globalStyle: {
    navigationBarTextStyle: 'black',
    navigationBarTitleText: 'uni-app',
    navigationBarBackgroundColor: '#F8F8F8',
    backgroundColor: '#F8F8F8',
  },
  tabBar: {
    color: '#cdcdcd',
    selectedColor: '#8b5cf6',
    borderStyle: 'white',
    backgroundColor: '#ffffff',
  },
  subPackages: [
    {
      root: 'pages-sub2',
      pages: [
        {
          path: 'test',
          style: {
            navigationBarTitleText: 'Pages Sub Test',
          },
        },
      ],
    },
    // 测试用例：嵌套已定义分包根 + 扫描到的新页面
    // 验证：admin/settings 应归入已有的 pages/admin 根
    {
      root: 'pages/admin',
      pages: [
        {
          path: 'dashboard',
          style: {
            navigationBarTitleText: 'Admin Dashboard',
          },
        },
      ],
    },
    // 测试用例：验证 shop/products 归入已有的 pages/shop 根
    {
      root: 'pages/shop',
      pages: [
        {
          path: 'index',
          style: {
            navigationBarTitleText: 'Shop',
          },
        },
      ],
    },
  ],
})
