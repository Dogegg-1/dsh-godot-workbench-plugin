extends SceneTree

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 3:
		quit(2)
		return
	var config := ConfigFile.new()
	if config.load(args[0]) != OK:
		quit(3)
		return
	for section in config.get_sections():
		if section.replace("\\", "/").trim_suffix("/").to_lower() == args[2].trim_suffix("/").to_lower():
			print("WORKBENCH_REGISTER_OK WORKBENCH_ALREADY_PRESENT")
			quit(0)
			return
	config.set_value(args[2], "favorite", false)
	if config.save(args[1]) != OK:
		quit(4)
		return
	print("WORKBENCH_REGISTER_OK")
	quit(0)
