extends SceneTree

var folder: String
var results: Array = []

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	folder = get_script().resource_path.get_base_dir()
	var scenario: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(folder + "/scenario.json"))
	var packed: Variant = load(ProjectSettings.get_setting("application/run/main_scene", ""))
	if not packed is PackedScene:
		finish(false)
		return
	var game: Node = packed.instantiate()
	root.add_child(game)
	current_scene = game
	for frame in range(5):
		await process_frame
	for step: Dictionary in scenario.steps:
		var result: Dictionary = {"label": step.label, "type": step.type, "passed": true}
		var target: Node = null
		if step.has("node"):
			target = game.get_node_or_null(NodePath(step.node))
			if target == null:
				result.passed = false
				result.reason = "找不到节点：" + step.node
		if result.passed:
			match step.type:
				"sample":
					for frame in range(int(step.warmupFrames)):
						await process_frame
					var samples: Array = []
					var previous: int = Time.get_ticks_usec()
					for frame in range(int(step.frames)):
						await process_frame
						var now: int = Time.get_ticks_usec()
						samples.append(float(now - previous) / 1000.0)
						previous = now
					result.samplesMs = samples
					result.environment = {"os": OS.get_name(), "cpu": OS.get_processor_name(), "gpu": RenderingServer.get_video_adapter_name(), "engine": Engine.get_version_info().string, "renderer": RenderingServer.get_current_rendering_method(), "windowWidth": root.size.x, "windowHeight": root.size.y, "maxFps": Engine.max_fps, "vsyncMode": DisplayServer.window_get_vsync_mode(), "focused": root.has_focus(), "screenshotsDuringSample": false}
				"wait":
					for frame in range(int(step.frames)):
						await process_frame
				"assert":
					var found := false
					for prop in target.get_property_list():
						if prop.name == step.property:
							found = true
					result.actual = target.get(step.property) if found else null
					result.expected = step.equals
					result.passed = found and result.actual == step.equals
				"click":
					if not target is Control or not target.is_visible_in_tree():
						result.passed = false
						result.reason = "目标不是可见界面控件"
					else:
						var position: Vector2 = target.get_global_rect().get_center()
						for pressed: bool in [true, false]:
							var event := InputEventMouseButton.new()
							event.position = position
							event.button_index = MOUSE_BUTTON_LEFT
							event.pressed = pressed
							root.push_input(event, true)
							await process_frame
				"key":
					var event := InputEventKey.new()
					event.keycode = int(step.code)
					event.physical_keycode = int(step.code)
					event.pressed = step.pressed
					event.echo = step.echo
					# Feed InputMap state as well as node callbacks.
					Input.parse_input_event(event)
					Input.flush_buffered_events()
					await process_frame
				"capture":
					await RenderingServer.frame_post_draw
					var picture := root.get_texture().get_image()
					var filename := "frame-%03d.png" % results.size()
					result.passed = picture != null and not picture.is_empty()
					if result.passed:
						result.width = picture.get_width()
						result.height = picture.get_height()
						result.passed = picture.save_png(folder + "/" + filename) == OK
						result.image = filename
		results.append(result)
		if not result.passed:
			finish(false)
			return
	finish(true)

func finish(complete: bool) -> void:
	var file := FileAccess.open(folder + "/result.json", FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify({"complete": complete, "steps": results}))
		file.close()
	quit(0 if complete else 1)
