# The engine executable: WebCore embedded in-process, driven by the host page.
# Included by WebCore's port CMake file after the WebCore target is complete, so
# WebCore's private include directories and definitions apply here as well.

set(INCEPTION_ENGINE_DIR "${CMAKE_CURRENT_LIST_DIR}")

file(GLOB INCEPTION_ENGINE_SOURCES CONFIGURE_DEPENDS "${INCEPTION_ENGINE_DIR}/*/*.cpp")
file(GLOB INCEPTION_ENGINE_JS CONFIGURE_DEPENDS "${INCEPTION_ENGINE_DIR}/js/*.js")

add_executable(inception-engine ${INCEPTION_ENGINE_SOURCES})
set_target_properties(inception-engine PROPERTIES
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

target_include_directories(inception-engine PRIVATE
    ${INCEPTION_ENGINE_DIR}
    ${WebCore_PRIVATE_INCLUDE_DIRECTORIES}
    ${WebCore_DERIVED_SOURCES_DIR}
)
target_link_libraries(inception-engine PRIVATE WebKit::WebCore)

# Worker-side glue lives in js/; each file is a library the engine calls into.
foreach (js IN LISTS INCEPTION_ENGINE_JS)
    target_link_options(inception-engine PRIVATE "--js-library=${js}")
endforeach ()
set_property(TARGET inception-engine APPEND PROPERTY LINK_DEPENDS ${INCEPTION_ENGINE_JS})

target_link_options(inception-engine PRIVATE
    # WebKit runs on one pthread; the page's main thread stays free for the host.
    -pthread
    -sPROXY_TO_PTHREAD=1
    # The engine's thread, the OPFS backend's thread, and spares.
    -sPTHREAD_POOL_SIZE=6
    -sDEFAULT_PTHREAD_STACK_SIZE=8MB
    -sSTACK_SIZE=8MB

    # Function names in the binary, so crashes report readable stacks.
    --profiling-funcs

    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=256MB
    -sMAXIMUM_MEMORY=4GB

    -sMIN_WEBGL_VERSION=2
    -sMAX_WEBGL_VERSION=2
    -sGL_ENABLE_GET_PROC_ADDRESS=1

    # WasmFS: file system calls run on the calling thread. Sockets are the
    # engine's own (net/Sockets.cpp): it wraps the socket calls WasmFS answers
    # with ENOSYS, and descriptor calls that must also accept sockets.
    -sWASMFS=1
    -Wl,--wrap=__syscall_socket
    -Wl,--wrap=__syscall_connect
    -Wl,--wrap=__syscall_getsockopt
    -Wl,--wrap=__syscall_getsockname
    -Wl,--wrap=__syscall_getpeername
    -Wl,--wrap=__syscall_sendto
    -Wl,--wrap=__syscall_recvfrom
    -Wl,--wrap=__syscall_sendmsg
    -Wl,--wrap=__syscall_recvmsg
    -Wl,--wrap=__syscall_bind
    -Wl,--wrap=__syscall_listen
    -Wl,--wrap=__syscall_accept4
    -Wl,--wrap=__syscall_poll
    -Wl,--wrap=__syscall_fcntl64
    -Wl,--wrap=__syscall_ioctl
    -Wl,--wrap=__wasi_fd_close

    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createInceptionEngine
    -sENVIRONMENT=web,worker
    -sEXIT_RUNTIME=0
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP32,PThread,wasmMemory
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free
    "-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=$inceptionBridgeInstall,$inceptionGfxInstall"

    "--preload-file=${INCEPTION_FS_DIR}@/"
)
