<template>
  <view>Pages Sub Internal</view>
</template>

<script setup lang="ts">
import { onShow } from "@dcloudio/uni-app";

onShow(() => {
  console.log("onShow");
});
</script>

<route lang="jsonc">
{
  "style": {
    "navigationBarTitleText": "Pages Sub Internal",
    // #ifdef H5
    "navigationStyle": "custom"
    // #endif
  }
}
</route>