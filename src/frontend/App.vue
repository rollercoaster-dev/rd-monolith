<script setup lang="ts">
// import { TooltipProvider } from '@/components/ui/tooltip';

// console.log('TooltipProvider loaded:', TooltipProvider);
console.log("App.vue is being loaded");
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <RdLayoutHeader />
    <main class="p-8">
      <RouterView />
    </main>
  </div>
</template>

<style>
@import "~/styles/main.css";
</style>
