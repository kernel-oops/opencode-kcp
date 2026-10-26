import assert from "node:assert/strict"
import test from "node:test"
import { fromJSON, toJSON } from "seroval"
import { URLPlugin } from "seroval-plugins/web"
import { renderToString } from "solid-js/web"

test("development Solid serializer binds the patched Seroval leaves", () => {
    const options = { plugins: [URLPlugin] }
    const restored = fromJSON(toJSON(new URL("https://example.invalid/boundary"), options), options)
    assert.ok(restored instanceof URL)
    assert.equal(restored.pathname, "/boundary")
    assert.match(
        renderToString(() => "boundary control"),
        /boundary control/,
    )
})
