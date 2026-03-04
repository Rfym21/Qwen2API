<template>
  <video id="video-background" autoplay loop muted>
    <source src="./assets/background.mp4" type="video/mp4">
  </video>

  <router-view></router-view>

</template>

<script setup>
</script>

<style lang="css" scoped>
body,
html {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

#video-background {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  object-fit: cover;
}
</style>
