<template>
  <div class="with-connection-type">
    <common-server-inputs
      :config="config"
      :support-complex-s-s-l="true"
    />
    <common-advanced :config="config" />
  </div>
</template>

<script>

  import CommonServerInputs from './CommonServerInputs.vue'
  import CommonAdvanced from './CommonAdvanced.vue'

  const HTTP_PORT = 8123
  const HTTPS_PORT = 8443

  export default {
    components: { CommonServerInputs, CommonAdvanced },
    props: {
      config: Object,
    },
    watch: {
      // ClickHouse serves HTTP and HTTPS on different ports. Follow the TLS
      // toggle, but leave a port the user typed themselves alone.
      'config.ssl'(ssl) {
        const from = ssl ? HTTP_PORT : HTTPS_PORT
        if (!this.config.port || Number(this.config.port) === from) {
          this.config.port = ssl ? HTTPS_PORT : HTTP_PORT
        }
      }
    }
  }
</script>
