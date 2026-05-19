<template>
  <view>Admin Settings</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';

onShow(() => {
  console.log('Admin Settings page shown');
});
</script>

<route lang="jsonc" part="subPackage">
{
  "style": {
    "navigationBarTitleText": "Admin Settings",
    // #ifdef H5
    "navigationStyle": "custom"
    // #endif
  }
}
</route>
