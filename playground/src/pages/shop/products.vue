<template>
  <view>Shop Products</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';

onShow(() => {
  console.log('Shop Products page shown');
});
</script>

<route lang="jsonc" part="subPackage">
{
  "style": {
    "navigationBarTitleText": "Shop Products",
    // #ifdef H5
    "navigationStyle": "custom"
    // #endif
  }
}
</route>
