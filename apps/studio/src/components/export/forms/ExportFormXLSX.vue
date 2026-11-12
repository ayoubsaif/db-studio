<template>
  <div>
    <div class="form-group">
      <label for="sheetName">Sheet Name</label>
      <input
        v-model="options.sheetName"
        id="sheetName"
        type="text"
        class="form-control"
        maxlength="31"
        placeholder="Table or query name"
      >
    </div>
    <div class="form-group">
      <label
        for="xlsxHeaderRow"
        class="checkbox-group"
      >
        <input
          v-model="options.header"
          id="xlsxHeaderRow"
          type="checkbox"
          name="xlsxHeaderRow"
          class="form-control"
        >
        <span>Include Header</span>
      </label>
    </div>
    <p class="text-muted small">
      Rows past Excel's limit of 1,048,576 per sheet continue on extra sheets.
      For millions of rows, CSV is much faster.
    </p>
  </div>
</template>

<script>
export default {
  props: {
    value: {
      required: true,
    },
  },
  data() {
    return {
      options: {
        header: true,
        sheetName: "",
      },
    };
  },
  watch: {
    options: {
      deep: true,
      handler(newVal) {
        this.$emit("input", newVal);
      },
    },
  },
  mounted() {
    this.$emit("input", this.options);
  },
};
</script>
