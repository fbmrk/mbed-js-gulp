'use strict';

module.exports = function(gulp) {

    const run = require('gulp-run');
    const util = require('gulp-util');
    const print = require('gulp-print');
    const filter = require('gulp-filter');
    const uglify = require('gulp-uglify');
    const rename = require('gulp-rename');
    const template = require('gulp-template');

    const browserify = require('browserify');
    const promisify = require('promisify-node');
    const uglifyify = require('uglifyify');

    const buffer = require('vinyl-buffer');
    const source = require('vinyl-source-stream');

    const npm = require('npm');

    const fs = require('fs');
    const del = require('del');
    const exec = require('child-process-promise').exec;

    const isWindows = require('os').platform() === 'win32';

    const node_package = JSON.parse(fs.readFileSync('./package.json'));

    gulp.task('bundle', ['make-build-dir'], function() {
        var noParse = [];

        try {
            noParse.push(require.resolve('bleno'));
        } catch (e) { /* empty */ }

        const b = browserify({
            entries: node_package.main,
            noParse: noParse,
            builtins: false
        });

        b.transform({
            global: true,
            compress: {
                dead_code: true,
                global_defs: {
                    __jerryscript: true
                }
            }
        }, uglifyify);

        return b.bundle()
                .pipe(source(node_package.name + '.bundle.min.js'))
                .pipe(buffer())

                // output bundled js
                .pipe(gulp.dest('./build/js/'));
    });

    function cpp_name_sanitise(name) {
        let out_name = name.replace(new RegExp('-', 'g'), '_')
                           .replace(new RegExp('\\\\', 'g'), '_')
                           .replace(new RegExp('\\?', 'g'), '_')
                           .replace(new RegExp('\'', 'g'), '_')
                           .replace(new RegExp('"', 'g'), '_');

        if ("0123456789".indexOf(out_name[0]) != -1) {
            out_name = '_' + out_name;
        }

        return out_name;
    }

    function cpp_string_sanitise(string) {
        let out_str = string.replace(new RegExp('\\\\', 'g'), '\\\\')
                            .replace(new RegExp("\n", 'g'), "\\n")
                            .replace(new RegExp("\"", 'g'), '\\"');

        return out_str;
    }

    gulp.task('cppify', ['get-jerryscript', 'bundle'], function() {
        return exec("python jerryscript/tools/js2c.py --ignore pins.js --no-main",
                    { cwd: './build' });
    });

    gulp.task('pins', ['tools', 'get-mbed-os', 'bundle'], function() {
        return exec("python tools/generate_pins.py " + util.env.target,
                    { cwd: './build' });
    });

    gulp.task('requirements', ['tools'], function() {
        return exec("pip install -r requirements.txt",
                    { cwd: './build/tools' });
    });

    gulp.task('source', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/source')) {
          return gulp.src(__dirname + '/source/**/*')
                     .pipe(gulp.dest('./build/source/'));
        }
    });

    gulp.task('tools', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/tools')) {
          return gulp.src(__dirname + '/tools/*')
                     .pipe(gulp.dest('./build/tools/'));
        }
    });

    gulp.task('mbed_app', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/mbed_app.json')) {
          return gulp.src(__dirname + '/tmpl/mbed_app.json.tmpl')
                     .pipe(rename('mbed_app.json'))
                     .pipe(gulp.dest('./build/'));
        }
    });

    gulp.task('ignorefile', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/.mbedignore')) {
          return gulp.src(__dirname + '/tmpl/mbedignore.tmpl')
                     .pipe(rename('.mbedignore'))
                     .pipe(gulp.dest('./build/'));
        }
    });

    // avoid deleting jerryscript et. al, since it makes subsequent builds really slow
    gulp.task('clean', function() {
        return del(['build/out']);
    });

    // delete all the things
    gulp.task('deepclean', function() {
        return del(['build']);
    });

    gulp.task('make-build-dir', function() {
        if (!fs.existsSync('./build')) {
            fs.mkdirSync('./build');
        }
    });

    gulp.task('get-jerryscript', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/jerryscript')) {
            return run("git clone https://github.com/jerryscript-project/jerryscript", { cwd: './build' }).exec();
        }
    });

    gulp.task('get-mbed-os', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/mbed-os')) {
            return run('git clone https://github.com/ARMmbed/mbed-os', { cwd: './build' }).exec();
        }
    });

    gulp.task('config', ['make-build-dir'], function() {
        if (!fs.existsSync('./build/.mbed')) {
            let commands = [
              'echo "ROOT=." > .mbed',
              'mbed config root .',
              'mbed toolchain GCC_ARM',
            ];

            let cmd;
            if (isWindows) {
                cmd = commands.join(' & ');
            }
            else {
                cmd = commands.join('; ');
            }

            return run(cmd, { cwd: './build' }).exec();
        }
    });

    function dependencies(obj) {
        console.log(obj.dependencies)
        return obj.dependencies.map(Object.keys) + obj.dependencies.map(dependencies);
    }

    function list_libs() {
        return new Promise(function(resolve, reject) {
            npm.load({ production: true, depth: 0, progress: false }, function(err, npm) {
                var native_packages = [];
                npm.commands.ls([], true, function dependencies(err, data, lite) {
                    function recurse_dependencies(list) {
                        if (!list) {
                            return;
                        }

                        let keys = Object.keys(list);

                        for (let i = 0; i < keys.length; i++) {
                            if (list[keys[i]] && !list[keys[i]].missing) {
                                // check for mbedjs.json
                                var path = list[keys[i]].path + '/mbedjs.json';

                                try {
                                    fs.statSync(path);
                                } catch (e) {
                                    recurse_dependencies(list[keys[i]].dependencies);
                                    continue;
                                }

                                list[keys[i]].path = list[keys[i]].path.replace(new RegExp(/\\/, 'g'), "/");

                                var json_data = JSON.parse(fs.readFileSync(path));

                                native_packages.push({
                                    name: list[keys[i]].name,
                                    abs_source: json_data.source.map(function(dir) {
                                        return list[keys[i]].path.replace("\\", "/") + '/' + dir
                                    }),
                                    config: json_data
                                });
                                recurse_dependencies(list[keys[i]].dependencies);
                            }
                        }
                    }

                    recurse_dependencies(data.dependencies);

                    resolve(native_packages);
                });
            });
        });
    }

    function parse_pins(path) {
        return promisify(fs.readFile)(path, { encoding: 'utf-8' }).then(function(pin_data) {
            return pin_data.split('\n')
                    .filter(function(line) {
                        let bits = line.split(' ');
                        return bits.length == 4;
                    })
                    .map(function(line) {
                        let bits = line.split(' ');

                        return {
                            name: bits[1],
                            value: bits[3].slice(0, -1)
                        };
                    });
        });
    }

    gulp.task('build', ['config', 'cppify', 'ignorefile', 'source', 'pins', 'mbed_app', 'requirements'], function() {
        return list_libs()
                .then(function(libs) {
                    var native_list = libs.map(function(p) { return util.colors.cyan(p.name) });

                    if (native_list.length > 0) {
                        util.log("Found native packages: " + native_list.join(", "));
                    } else {
                        util.log("Found no native packages.");
                    }

                    var gulp_stream = gulp.src(__dirname + '/tmpl/main.cpp.tmpl')
                                        .pipe(rename('main.cpp'))
                                        .pipe(template({
                                            libraries: libs
                                        }))
                                        .pipe(gulp.dest('./build/source/'));

                    return new Promise(function(resolve, reject) {
                        gulp_stream.on('end', function() {
                            // include the native_extras library if it exists
                            fs.stat("./native_extras", function(err) {
                                var lib_dirs = libs.map(function(lib) { return lib.abs_source.join(':'); });

                                if (!err) {
                                    lib_dirs.push("../../../../native_extras/");
                                }

                                var lib_source_files = lib_dirs.join(':');

                                let commands = [
                                  'mbed target ' + util.env.target,
                                  'mbed compile -j0 --source . --build ./out/' + util.env.target
                                  + ' -D "CONFIG_MEM_HEAP_AREA_SIZE=(1024*16)"',
                                ];

                                if (lib_source_files) {
                                  commands[1] += ' --source ' + lib_source_files;
                                }

                                let cmd;
                                if (isWindows) {
                                    cmd = commands.join(' & ');
                                }
                                else {
                                    cmd = commands.join('; ');
                                }

                                resolve(run(cmd, { cwd: './build', verbosity: 3 }).exec()
                                .pipe(print())
                                .pipe(rename('build.log'))
                                .pipe(gulp.dest('./build')));
                            });
                        });
                    });
                })
    });

    gulp.task('default', ['build']);
};
